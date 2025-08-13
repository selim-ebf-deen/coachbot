// server.js — CoachBot (JSON storage + health endpoints)
// ES modules
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

// ---------------- App & middlewares ----------------
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------------- Paths / filenames ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH     = process.env.DB_PATH     || "/data/journal.json"; // discussions par jour
const META_PATH   = process.env.META_PATH   || "/data/meta.json";     // prénom + DISC
const PROMPT_PATH = process.env.PROMPT_PATH || path.join(__dirname, "prompt.txt");

// ---------------- Utils: files & JSON ----------------
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function saveJSON(p, obj) { ensureDir(p); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function getPromptText() {
  try { return fs.readFileSync(PROMPT_PATH, "utf-8"); }
  catch { return "Tu es CoachBot. Réponds en français, de façon brève, concrète, en tutoyant."; }
}

// ---------------- DB helpers (robustes) ----------------
function loadDB() {
  const raw = loadJSON(DB_PATH, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
}
function saveDB(db) { saveJSON(DB_PATH, db); }

function getEntries(day) {
  const db  = loadDB();
  const key = String(day);
  const val = db[key];
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object") return [val]; // compat anciens enregistrements
  return [];
}
function addEntry(day, entry) {
  const db  = loadDB();
  const key = String(day);
  const val = db[key];

  let arr;
  if (Array.isArray(val)) arr = val;
  else if (val && typeof val === "object") arr = [val];
  else arr = [];

  arr.push(entry);
  db[key] = arr;
  saveDB(db);
}

// ---------------- Meta (prénom + DISC) ----------------
function loadMeta() { return loadJSON(META_PATH, { name: null, disc: null }); }
function saveMeta(meta) { saveJSON(META_PATH, meta); }

// ---------------- Migration douce au démarrage ----------------
(function migrateJournal() {
  const db = loadDB();
  let changed = false;
  for (const k of Object.keys(db)) {
    const v = db[k];
    if (Array.isArray(v)) continue;
    if (v && typeof v === "object") { db[k] = [v]; changed = true; }
    else { db[k] = []; changed = true; }
  }
  if (changed) saveDB(db);
})();

// ---------------- Heuristiques prénom & DISC ----------------
function maybeExtractName(text) {
  const t = (text || "").trim();
  let m = t.match(/je m(?:'|e)appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
       || t.match(/moi c['’]est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
       || (t.split(/\s+/).length === 1 ? [null, t] : null);
  return m ? m[1].trim().replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g,"") : null;
}
function inferDISC(text) {
  const t = (text || "").trim();
  const len = t.length;
  const ex  = (t.match(/!/g)||[]).length;
  const hasCaps = /[A-Z]{3,}/.test(t);
  const hasNums = /\d/.test(t);
  const asksDetail  = /(détail|exact|précis|critère|mesurable|plan|checklist)/i.test(t);
  const caresPeople = /(écoute|relation|aider|ensemble|émotion|ressenti|bienveillance)/i.test(t);
  const wantsAction = /(action|résultat|vite|maintenant|objectif|deadline|priorit)/i.test(t);

  if (wantsAction && (ex>0 || hasCaps)) return "D";
  if (ex>1 || /cool|idée|créatif|enthous|fun/i.test(t)) return "I";
  if (caresPeople || /calme|rassure|routine|habitude/i.test(t)) return "S";
  if (asksDetail || hasNums || len>240) return "C";
  return null;
}

// ---------------- Plans du jour (référence) ----------------
const plans = {
  1:"Jour 1 — Clarification des intentions : précise le défi prioritaire à résoudre en 15 jours, pourquoi c’est important, et ce que ‘réussir’ signifie concrètement.",
  2:"Jour 2 — Diagnostic de la situation actuelle : état des lieux, 3 leviers, 3 obstacles.",
  3:"Jour 3 — Vision et critères de réussite : issue idéale + 3 indicateurs.",
  4:"Jour 4 — Valeurs et motivations : aligne objectifs et valeurs.",
  5:"Jour 5 — Énergie : estime de soi / amour propre / confiance.",
  6:"Jour 6 — Confiance (suite) : preuves, retours, micro‑victoires.",
  7:"Jour 7 — Bilan et KISS (Keep‑Improve‑Start‑Stop).",
  8:"Jour 8 — Nouveau départ : cap et prochaines 48h.",
  9:"Jour 9 — Plan d’action simple : 1 chose / jour.",
  10:"Jour 10 — CNV : préparer un message clé.",
  11:"Jour 11 — Décisions : Stop / Keep / Start.",
  12:"Jour 12 — Échelle de responsabilité : au‑dessus de la ligne.",
  13:"Jour 13 — Co‑développement éclair (pairing).",
  14:"Jour 14 — Leadership (Maxwell).",
  15:"Jour 15 — Bilan final + plan 30 jours."
};

// ---------------- Static UI ----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------------- Journal API ----------------
app.get("/api/journal", (req, res) => {
  const day = Number(req.query.day || 1);
  return res.json(getEntries(day));
});
app.post("/api/journal/save", (req, res) => {
  const { day = 1, message = "", role = "user" } = req.body || {};
  addEntry(day, { role, message, date: new Date().toISOString() });
  return res.json({ success: true });
});

// ---------------- Meta API (prénom / DISC) ----------------
app.get("/api/meta", (_req, res) => res.json(loadMeta()));
app.post("/api/meta", (req, res) => {
  const meta = loadMeta();
  if (req.body?.name) meta.name = String(req.body.name).trim();
  if (req.body?.disc) meta.disc = String(req.body.disc).toUpperCase();
  saveMeta(meta);
  res.json({ success: true, meta });
});

// ---------------- IA helpers ----------------
function systemPrompt(name, disc) {
  const base = getPromptText();
  const note =
    `\n\n[Contexte CoachBot]\nPrénom: ${name || "Inconnu"}\nDISC: ${disc || "À déduire"}\n` +
    `Rappels: réponses courtes, concrètes, micro‑action 10 min, critère de réussite, tutoiement.`;
  return base + note;
}
function makeUserPrompt(day, message) {
  const plan = plans[Number(day)] || "Plan non spécifié.";
  return `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;
}

// ---------------- Chat non-stream ----------------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const meta = loadMeta();

    if (!meta.name) {
      const n = maybeExtractName(message);
      if (n && n.length >= 2) { meta.name = n; saveMeta(meta); }
    }
    if (!meta.disc) {
      const d = inferDISC(message);
      if (d) { meta.disc = d; saveMeta(meta); }
    }

    addEntry(day, { role: "user", message, date: new Date().toISOString() });

    const system = systemPrompt(meta.name, meta.disc);
    const user   = makeUserPrompt(day, message);

    if (provider === "anthropic" || provider === "claude") {
      if (!process.env.ANTHROPIC_API_KEY)
        return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante" });

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4,
          system,
          messages: [{ role: "user", content: user }]
        })
      });

      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = null; }

      if (!r.ok) {
        console.error("Claude error:", r.status, text);
        return res.status(500).json({ error: `Claude error ${r.status}`, details: text });
      }

      const reply = data?.content?.[0]?.text || "Je n’ai pas compris, peux-tu reformuler ?";
      addEntry(day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    return res.status(400).json({ error: "Fournisseur inconnu ou non activé" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ---------------- Chat streaming (SSE) ----------------
app.post("/api/chat/stream", async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};
  const meta = loadMeta();

  if (!meta.name) {
    const n = maybeExtractName(message);
    if (n && n.length >= 2) { meta.name = n; saveMeta(meta); }
  }
  if (!meta.disc) {
    const d = inferDISC(message);
    if (d) { meta.disc = d; saveMeta(meta); }
  }

  addEntry(day, { role: "user", message, date: new Date().toISOString() });

  const system = systemPrompt(meta.name, meta.disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    if (provider === "anthropic" || provider === "claude") {
      if (!process.env.ANTHROPIC_API_KEY) { send({ error: "ANTHROPIC_API_KEY manquante" }); return end(); }

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4, stream: true,
          system,
          messages: [{ role: "user", content: user }]
        })
      });

      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(()=> "");
        console.error("Claude stream error:", resp.status, t);
        send({ error: `Claude stream error ${resp.status}: ${t}` });
        return end();
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") break;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              const delta = evt.delta.text || "";
              if (delta) { full += delta; send({ text: delta }); }
            }
          } catch { /* ignore malformed lines */ }
        }
      }
      if (full) addEntry(day, { role: "ai", message: full, date: new Date().toISOString() });
      return end();
    }

    send({ error: "Fournisseur inconnu ou non activé" }); return end();
  } catch (e) {
    console.error(e);
    send({ error: "Erreur serveur" }); return end();
  }
});

// ---------------- Health / Ready / Version ----------------
app.get("/healthz", (_req, res) => {
  // check fichiers essentiels
  const dbExists   = fs.existsSync(DB_PATH);
  const metaExists = fs.existsSync(META_PATH);
  res.status(200).json({
    ok: true,
    db: dbExists ? "ok" : "missing",
    meta: metaExists ? "ok" : "missing"
  });
});

app.get("/readyz", (_req, res) => {
  // simple readiness (tu peux enrichir plus tard)
  res.status(200).json({ ready: true });
});

app.get("/version", (_req, res) => {
  res.json({
    name: "coachbot",
    env: process.env.NODE_ENV || "production",
    model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
    time: new Date().toISOString()
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur en ligne sur le port ${PORT}`));
