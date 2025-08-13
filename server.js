// server.js — CoachBot multi‑users (Claude + JWT + journaux par jour)
// Node >= 20 (fetch natif) — ES Modules

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

/* ----------------------- App & middlewares ----------------------- */
const app = express();
app.use(cors());
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ----------------------- Config via ENV ------------------------- */
const PORT             = process.env.PORT || 3000;
const USERS_PATH       = process.env.USERS_PATH    || "/data/users.json";
const JOURNAL_PATH     = process.env.JOURNAL_PATH  || "/data/journal.json";
const META_PATH        = process.env.META_PATH     || "/data/meta.json";
const PROMPT_PATH      = process.env.PROMPT_PATH   || path.join(__dirname, "prompt.txt");
const JWT_SECRET       = process.env.JWT_SECRET    || "dev-secret-change-me";
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL  = process.env.ANTHROPIC_MODEL   || "claude-3-5-sonnet-20241022";

/* ----------------------- File helpers --------------------------- */
function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}
function loadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}
function saveJSON(p, obj) {
  ensureDir(p);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function readPrompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, "utf-8");
  } catch {
    return "Tu es CoachBot. Réponds en français, de façon brève, concrète, en tutoyant.";
  }
}

/* ----------------------- Stores (fichiers) ---------------------- */
// users.json  : { users: [{ id, email, passwordHash, name, createdAt }], nextId }
// journal.json: { [userId]: { [day]: [{role, message, date}] } }
// meta.json   : { [userId]: { name, disc } }

function initStores() {
  const u = loadJSON(USERS_PATH, null);
  if (!u || typeof u !== "object" || !Array.isArray(u?.users)) {
    saveJSON(USERS_PATH, { users: [], nextId: 1 });
  }
  const j = loadJSON(JOURNAL_PATH, null);
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    saveJSON(JOURNAL_PATH, {});
  }
  const m = loadJSON(META_PATH, null);
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    saveJSON(META_PATH, {});
  }
}
initStores();

/* ----------------------- Small utils ---------------------------- */
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

function maybeExtractName(text) {
  const t = (text || "").trim();
  let m =
    t.match(/je m(?:'|e)appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i) ||
    t.match(/moi c['’]est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i) ||
    (t.split(/\s+/).length === 1 ? [null, t] : null);
  return m ? m[1].trim().replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g, "") : null;
}
function inferDISC(text) {
  const t = (text || "").trim();
  const len = t.length;
  const ex  = (t.match(/!/g) || []).length;
  const hasCaps = /[A-Z]{3,}/.test(t);
  const hasNums = /\d/.test(t);
  const asksDetail  = /(détail|exact|précis|critère|mesurable|plan|checklist)/i.test(t);
  const caresPeople = /(écoute|relation|aider|ensemble|émotion|ressenti|bienveillance)/i.test(t);
  const wantsAction = /(action|résultat|vite|maintenant|objectif|deadline|priorit)/i.test(t);
  if (wantsAction && (ex > 0 || hasCaps)) return "D";
  if (ex > 1 || /cool|idée|créatif|enthous|fun/i.test(t)) return "I";
  if (caresPeople || /calme|rassure|routine|habitude/i.test(t)) return "S";
  if (asksDetail || hasNums || len > 240) return "C";
  return null;
}

/* ----------------------- Auth helpers --------------------------- */
function usersStore() { return loadJSON(USERS_PATH, { users: [], nextId: 1 }); }
function saveUsers(store) { saveJSON(USERS_PATH, store); }

function findUserByEmail(email) {
  const s = usersStore();
  return s.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()) || null;
}
function findUserById(id) {
  const s = usersStore();
  return s.users.find(u => u.id === id) || null;
}

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
}
function auth(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.uid);
    if (!user) return res.status(401).json({ error: "Utilisateur inconnu" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide" });
  }
}

/* ----------------------- Journal & Meta per user ---------------- */
function journalStore() { return loadJSON(JOURNAL_PATH, {}); }
function saveJournal(obj) { saveJSON(JOURNAL_PATH, obj); }
function metaStore() { return loadJSON(META_PATH, {}); }
function saveMetaStore(obj) { saveJSON(META_PATH, obj); }

function getUserDayEntries(userId, day) {
  const j = journalStore();
  const u = j[userId] || {};
  const arr = u[day];
  if (Array.isArray(arr)) return arr;
  return [];
}
function addUserEntry(userId, day, entry) {
  const j = journalStore();
  j[userId] = j[userId] || {};
  j[userId][day] = j[userId][day] || [];
  j[userId][day].push(entry);
  saveJournal(j);
}
function getUserMeta(userId) {
  const m = metaStore();
  return m[userId] || { name: null, disc: null };
}
function setUserMeta(userId, patch) {
  const m = metaStore();
  m[userId] = { ...(m[userId] || { name: null, disc: null }), ...patch };
  saveMetaStore(m);
  return m[userId];
}

/* ----------------------- Static / UI ---------------------------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ----------------------- Health ------------------------------- */
app.get("/healthz", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ----------------------- Auth API ------------------------------ */
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email et password requis" });
    if (findUserByEmail(email)) return res.status(409).json({ error: "Email déjà utilisé" });

    const s = usersStore();
    const id = s.nextId++;
    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = { id, email: String(email), passwordHash, name: name || null, createdAt: new Date().toISOString() };
    s.users.push(user);
    saveUsers(s);

    // init méta si prénom fourni
    if (name) setUserMeta(id, { name });

    const token = signToken(user);
    res.json({ token, user: { id, email, name: user.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = findUserByEmail(email);
    if (!user) return res.status(401).json({ error: "Identifiants invalides" });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Identifiants invalides" });
    const token = signToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/me", auth, (req, res) => {
  const meta = getUserMeta(req.user.id);
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name ?? meta.name }, meta });
});

/* ----------------------- Journal API --------------------------- */
app.get("/api/journal", auth, (req, res) => {
  const day = String(req.query.day || 1);
  res.json(getUserDayEntries(req.user.id, day));
});
app.post("/api/journal/save", auth, (req, res) => {
  const { day = 1, message = "", role = "user" } = req.body || {};
  addUserEntry(req.user.id, String(day), { role, message, date: new Date().toISOString() });
  res.json({ success: true });
});

/* ----------------------- Meta API ------------------------------ */
app.get("/api/meta", auth, (req, res) => res.json(getUserMeta(req.user.id)));
app.post("/api/meta", auth, (req, res) => {
  const patch = {};
  if (req.body?.name) patch.name = String(req.body.name).trim();
  if (req.body?.disc) patch.disc = String(req.body.disc).toUpperCase();
  const meta = setUserMeta(req.user.id, patch);
  res.json({ success: true, meta });
});

/* ----------------------- Prompt builders ----------------------- */
function systemPrompt(name, disc) {
  const base = readPrompt();
  const note =
    `\n\n[Contexte CoachBot]\nPrénom: ${name || "Inconnu"}\nDISC: ${disc || "À déduire"}\n` +
    `Rappels: réponses courtes, concrètes, micro‑action 10 min, critère de réussite, tutoiement.`;
  return base + note;
}
function makeUserPrompt(day, message) {
  const plan = plans[Number(day)] || "Plan non spécifié.";
  return `Plan du jour (J${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;
}

/* ----------------------- Chat (non‑stream) --------------------- */
app.post("/api/chat", auth, async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const meta = getUserMeta(req.user.id);

    // Si pas de prénom / DISC -> heuristiques
    if (!meta.name) {
      const n = maybeExtractName(message);
      if (n && n.length >= 2) setUserMeta(req.user.id, { name: n });
    }
    if (!meta.disc) {
      const d = inferDISC(message);
      if (d) setUserMeta(req.user.id, { disc: d });
    }

    addUserEntry(req.user.id, String(day), { role: "user", message, date: new Date().toISOString() });

    const system = systemPrompt(getUserMeta(req.user.id).name, getUserMeta(req.user.id).disc);
    const user   = makeUserPrompt(day, message);

    if ((provider === "anthropic" || provider === "claude")) {
      if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante" });

      // Contexte court : les 10 derniers messages du jour pour garder le fil
      const history = getUserDayEntries(req.user.id, String(day)).slice(-10);
      const historyText = history.map(h => `${h.role === "ai" ? "Coach" : "Utilisateur"}: ${h.message}`).join("\n");

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 800,
          temperature: 0.4,
          system,
          messages: [{ role: "user", content: `${user}\n\nHistorique récent:\n${historyText}` }]
        })
      });

      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = null; }
      if (!r.ok) {
        console.error("Claude error:", r.status, text);
        return res.status(500).json({ error: `Claude error ${r.status}`, details: text });
      }
      const reply = data?.content?.[0]?.text || "Je n’ai pas compris, peux-tu reformuler ?";
      addUserEntry(req.user.id, String(day), { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    return res.status(400).json({ error: "Fournisseur inconnu ou non activé" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ----------------------- Chat streaming (SSE) ------------------ */
app.post("/api/chat/stream", auth, async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};

  // heuristiques prénom / DISC
  const meta0 = getUserMeta(req.user.id);
  if (!meta0.name) {
    const n = maybeExtractName(message);
    if (n && n.length >= 2) setUserMeta(req.user.id, { name: n });
  }
  if (!meta0.disc) {
    const d = inferDISC(message);
    if (d) setUserMeta(req.user.id, { disc: d });
  }

  addUserEntry(req.user.id, String(day), { role: "user", message, date: new Date().toISOString() });

  const meta = getUserMeta(req.user.id);
  const system = systemPrompt(meta.name, meta.disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    if ((provider === "anthropic" || provider === "claude")) {
      if (!ANTHROPIC_KEY) { send({ error: "ANTHROPIC_API_KEY manquante" }); return end(); }

      // Contexte court
      const history = getUserDayEntries(req.user.id, String(day)).slice(-10);
      const historyText = history.map(h => `${h.role === "ai" ? "Coach" : "Utilisateur"}: ${h.message}`).join("\n");

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 800,
          temperature: 0.4,
          stream: true,
          system,
          messages: [{ role: "user", content: `${user}\n\nHistorique récent:\n${historyText}` }]
        })
      });

      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => "");
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
          } catch { /* ignore malformed */ }
        }
      }
      if (full) addUserEntry(req.user.id, String(day), { role: "ai", message: full, date: new Date().toISOString() });
      return end();
    }

    send({ error: "Fournisseur inconnu ou non activé" });
    return end();
  } catch (e) {
    console.error(e);
    send({ error: "Erreur serveur" });
    return end();
  }
});

/* ----------------------- Start server -------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Serveur en ligne sur le port ${PORT}`);
});
