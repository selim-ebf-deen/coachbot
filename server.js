// server.js — CoachBot complet (ESM)
// ----------------------------------
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

// ----------------------------------------------------
// App & middlewares
// ----------------------------------------------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Fichiers de persistance (par défaut dans /data)
const USERS_PATH   = process.env.USERS_PATH   || "/data/users.json";
const JOURNAL_PATH = process.env.JOURNAL_PATH || "/data/journal.json";
const META_PATH    = process.env.META_PATH    || "/data/meta.json";
const PROMPT_PATH  = process.env.PROMPT_PATH  || path.join(__dirname, "prompt.txt");

const JWT_SECRET   = process.env.JWT_SECRET || "change_me_very_long_secret";
const JWT_EXPIRES  = process.env.JWT_EXPIRES || "30d";

// Claude / Anthropic
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

// Admin seed (facultatif)
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_NAME     = process.env.ADMIN_NAME     || "Admin";

// ----------------------------------------------------
// Utils fichiers JSON
// ----------------------------------------------------
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function saveJSON(p, obj) { ensureDir(p); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// Chargements init
function loadUsers() { return loadJSON(USERS_PATH, {}); }
function saveUsers(o) { saveJSON(USERS_PATH, o); }

function loadJournal() { return loadJSON(JOURNAL_PATH, {}); }
function saveJournal(o) { saveJSON(JOURNAL_PATH, o); }

function loadMeta() { return loadJSON(META_PATH, {}); }
function saveMeta(o) { saveJSON(META_PATH, o); }

function getPromptText() {
  try { return fs.readFileSync(PROMPT_PATH, "utf-8"); }
  catch { return "Tu es CoachBot. Réponds en français, de façon brève, concrète, en tutoyant."; }
}

// ----------------------------------------------------
// Helpers auth / tokens
// ----------------------------------------------------
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const [, token] = h.split(" ");
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const payload = jwt.verify(token, JWT_SECRET);
    const users = loadUsers();
    const user = users[payload.sub];
    if (!user) return res.status(401).json({ error: "Utilisateur introuvable" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide" });
  }
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Accès admin requis" });
  next();
}
function newId(prefix = "u") {
  return `${prefix}_${Math.random().toString(36).slice(2,10)}`;
}

// ----------------------------------------------------
// Migration douce : garantir les structures
// ----------------------------------------------------
(function migrateAll() {
  // journal: { [userId]: { [day]: [ {role,message,date} ] } }
  const j = loadJournal(); let changedJ = false;
  for (const uid of Object.keys(j)) {
    const byDay = j[uid];
    if (!byDay || typeof byDay !== "object") { j[uid] = {}; changedJ = true; continue; }
    for (const day of Object.keys(byDay)) {
      const v = byDay[day];
      if (Array.isArray(v)) continue;
      if (v && typeof v === "object") { byDay[day] = [v]; changedJ = true; }
      else { byDay[day] = []; changedJ = true; }
    }
  }
  if (changedJ) saveJournal(j);

  // meta: { [userId]: { name, disc } }
  const m = loadMeta(); let changedM = false;
  for (const uid of Object.keys(m)) {
    const v = m[uid];
    if (!v || typeof v !== "object") { m[uid] = { name: null, disc: null }; changedM = true; }
    else {
      if (!("name" in v)) { v.name = null; changedM = true; }
      if (!("disc" in v)) { v.disc = null; changedM = true; }
    }
  }
  if (changedM) saveMeta(m);
})();

// ----------------------------------------------------
// Seed d’un admin si ADMIN_EMAIL fourni
// ----------------------------------------------------
(function seedAdmin() {
  if (!ADMIN_EMAIL) return;
  const users = loadUsers();
  const existing = Object.values(users).find(u => (u.email||"").toLowerCase() === ADMIN_EMAIL.toLowerCase());
  if (existing) return;
  if (!ADMIN_PASSWORD) { console.log("ADMIN_EMAIL défini mais pas ADMIN_PASSWORD => seed ignoré"); return; }

  const id = newId("adm");
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  users[id] = {
    id,
    email: ADMIN_EMAIL,
    name: ADMIN_NAME,
    role: "admin",
    passwordHash: hash,
    createdAt: new Date().toISOString()
  };
  saveUsers(users);
  console.log(`✅ Admin seed créé: ${ADMIN_EMAIL}`);
})();

// ----------------------------------------------------
// Plans du jour (affichage côté UI)
const plans = {
  1:"Clarification des intentions : défi prioritaire, pourquoi c’est important, succès concret.",
  2:"Diagnostic : 3 leviers + 3 obstacles.",
  3:"Vision + 3 indicateurs mesurables.",
  4:"Valeurs et motivations.",
  5:"Énergie : estime/confiance (3 niveaux).",
  6:"Confiance (suite) : preuves, retours, micro‑victoires.",
  7:"Bilan intermédiaire KISS (Keep/Improve/Start/Stop).",
  8:"Nouveau départ : cap + 48h.",
  9:"Plan simple : 1 action clé / jour.",
  10:"Préparer un message clé (CNV).",
  11:"Décisions : Stop / Keep / Start.",
  12:"Responsabilité : au‑dessus de la ligne.",
  13:"Co‑développement éclair.",
  14:"Leadership (Maxwell).",
  15:"Bilan final + plan 30 jours."
};

// ----------------------------------------------------
// Static (UI)
// ----------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// Healthcheck
app.get("/healthz", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ----------------------------------------------------
// AUTH
// ----------------------------------------------------
app.post("/api/auth/register", (req, res) => {
  const { email = "", password = "", name = null } = req.body || {};
  const e = String(email).trim().toLowerCase();
  if (!e || !password) return res.status(400).json({ error: "email et password requis" });

  const users = loadUsers();
  const already = Object.values(users).find(u => (u.email||"").toLowerCase() === e);
  if (already) return res.status(409).json({ error: "email déjà utilisé" });

  const id   = newId("u");
  const hash = bcrypt.hashSync(password, 10);
  users[id] = {
    id, email: e, name: name || null, role: "user",
    passwordHash: hash, createdAt: new Date().toISOString()
  };
  saveUsers(users);

  // init meta
  const meta = loadMeta();
  meta[id] = { name: name || null, disc: null };
  saveMeta(meta);

  const token = signToken(users[id]);
  res.json({ token, user: { id, email: e, name: users[id].name, role: users[id].role } });
});

app.post("/api/auth/login", (req, res) => {
  const { email = "", password = "" } = req.body || {};
  const e = String(email).trim().toLowerCase();
  const users = loadUsers();
  const user = Object.values(users).find(u => (u.email||"").toLowerCase() === e);
  if (!user) return res.status(401).json({ error: "identifiants invalides" });
  if (!bcrypt.compareSync(password, user.passwordHash)) return res.status(401).json({ error: "identifiants invalides" });

  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get("/api/me", authRequired, (req, res) => {
  const meta = loadMeta()[req.user.id] || { name: req.user.name || null, disc: null };
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role }, meta });
});

// ----------------------------------------------------
// JOURNAL & META (par utilisateur)
// ----------------------------------------------------
function getEntries(userId, day) {
  const j = loadJournal();
  const uid = j[userId] || {};
  const arr = uid[String(day)];
  if (Array.isArray(arr)) return arr;
  if (arr && typeof arr === "object") return [arr];
  return [];
}
function addEntry(userId, day, entry) {
  const j = loadJournal();
  if (!j[userId]) j[userId] = {};
  if (!Array.isArray(j[userId][String(day)])) j[userId][String(day)] = [];
  j[userId][String(day)].push(entry);
  saveJournal(j);
}

app.get("/api/journal", authRequired, (req, res) => {
  const day = Number(req.query.day || 1);
  res.json(getEntries(req.user.id, day));
});
app.post("/api/journal/save", authRequired, (req, res) => {
  const { day = 1, message = "", role = "user" } = req.body || {};
  addEntry(req.user.id, day, { role, message, date: new Date().toISOString() });
  res.json({ success: true });
});

app.get("/api/meta", authRequired, (req, res) => {
  const m = loadMeta()[req.user.id] || { name: req.user.name || null, disc: null };
  res.json(m);
});
app.post("/api/meta", authRequired, (req, res) => {
  const meta = loadMeta();
  if (!meta[req.user.id]) meta[req.user.id] = { name: req.user.name || null, disc: null };
  if (req.body?.name !== undefined) meta[req.user.id].name = String(req.body.name || "").trim() || null;
  if (req.body?.disc !== undefined) meta[req.user.id].disc = String(req.body.disc || "").toUpperCase() || null;
  saveMeta(meta);
  res.json({ success: true, meta: meta[req.user.id] });
});

// ----------------------------------------------------
// PROMPTS & CHAT (CLAUDE)
// ----------------------------------------------------
function systemPrompt(name, disc) {
  const base = getPromptText();
  const note =
    `\n\n[Contexte CoachBot]\nPrénom: ${name || "Inconnu"}\nDISC: ${disc || "À déduire"}\n` +
    `Rappels: tutoiement, réponses courtes et concrètes, micro‑action 10 min, critère de réussite.`;
  return base + note;
}
function makeUserPrompt(day, message) {
  const plan = plans[Number(day)] || "Plan non spécifié.";
  return `Plan du jour (J${day}) : ${plan}\n\nMessage utilisateur : ${message}`;
}

app.post("/api/chat", authRequired, async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const metaAll = loadMeta();
    const me = metaAll[req.user.id] || { name: req.user.name || null, disc: null };

    // Heuristiques rapides (nom depuis "je m'appelle ...") si absent
    if (!me.name) {
      const t = (message||"").trim();
      let m = t.match(/je m(?:'|e)appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
           || t.match(/moi c['’]est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i);
      if (m) { me.name = m[1].trim(); metaAll[req.user.id] = me; saveMeta(metaAll); }
    }

    addEntry(req.user.id, day, { role: "user", message, date: new Date().toISOString() });

    const system = systemPrompt(me.name, me.disc);
    const user   = makeUserPrompt(day, message);

    if (provider === "anthropic" || provider === "claude") {
      if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante" });

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 800,
          temperature: 0.4,
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
      addEntry(req.user.id, day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    return res.status(400).json({ error: "Fournisseur inconnu" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Streaming Claude (SSE)
app.post("/api/chat/stream", authRequired, async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};
  const metaAll = loadMeta();
  const me = metaAll[req.user.id] || { name: req.user.name || null, disc: null };

  addEntry(req.user.id, day, { role: "user", message, date: new Date().toISOString() });

  const system = systemPrompt(me.name, me.disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    if (provider !== "anthropic" && provider !== "claude") { send({ error: "Fournisseur inconnu" }); return end(); }
    if (!ANTHROPIC_API_KEY) { send({ error: "ANTHROPIC_API_KEY manquante" }); return end(); }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 800,
        temperature: 0.4,
        stream: true,
        system,
        messages: [{ role: "user", content: user }]
      })
    });

    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(()=> "");
      console.error("Claude stream error:", resp.status, t);
      send({ error: `Claude stream error ${resp.status}` });
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
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            const delta = evt.delta.text || "";
            if (delta) { full += delta; send({ text: delta }); }
          }
        } catch { /* ignore */ }
      }
    }
    if (full) addEntry(req.user.id, day, { role: "ai", message: full, date: new Date().toISOString() });
    return end();
  } catch (e) {
    console.error(e);
    send({ error: "Erreur serveur" }); return end();
  }
});

// ----------------------------------------------------
// ADMIN
// ----------------------------------------------------
app.get("/api/admin/users", authRequired, adminOnly, (_req, res) => {
  const users = loadUsers();
  const list = Object.values(users).map(u => ({
    id: u.id, email: u.email, name: u.name || null, role: u.role, createdAt: u.createdAt || null
  }));
  res.json(list);
});

app.post("/api/admin/user/role", authRequired, adminOnly, (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId || !["user", "admin"].includes(role)) return res.status(400).json({ error: "paramètres invalides" });
  const users = loadUsers();
  if (!users[userId]) return res.status(404).json({ error: "user introuvable" });
  users[userId].role = role;
  saveUsers(users);
  res.json({ success: true });
});

app.get("/api/admin/stats", authRequired, adminOnly, (_req, res) => {
  const users = loadUsers();
  const journal = loadJournal();

  const totalUsers = Object.keys(users).length;
  let totalMessages = 0;
  const perDay = Array.from({ length: 15 }, (_, i) => ({ day: i+1, count: 0 }));

  for (const uid of Object.keys(journal)) {
    const byDay = journal[uid] || {};
    for (let d = 1; d <= 15; d++) {
      const arr = byDay[String(d)];
      if (Array.isArray(arr)) { perDay[d-1].count += arr.length; totalMessages += arr.length; }
    }
  }
  res.json({ totalUsers, totalMessages, perDay });
});

// ----------------------------------------------------
// Lancement serveur
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur en ligne sur le port ${PORT}`));
