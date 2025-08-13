// server.js — CoachBot (complet, production-ready)

// ES Modules
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

// ---------------- Paths / App ----------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Fichiers (JSON)
const USERS_PATH   = process.env.USERS_PATH   || "/data/users.json";   // { [id]: {id,email,passHash,name,role,createdAt} }
const JOURNAL_PATH = process.env.JOURNAL_PATH || "/data/journal.json"; // { [userId]: { [day]: [ {role,message,date} ] } }
const META_PATH    = process.env.META_PATH    || "/data/meta.json";    // { [userId]: { name, disc } }
const PROMPT_PATH  = process.env.PROMPT_PATH  || path.join(__dirname, "prompt.txt");

// IA
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || "claude-3-5-sonnet-20241022";

// Auth
const JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET) console.warn("⚠️  JWT_SECRET manquant (env).");

// ---------------- Utils Fichiers ----------------
function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function saveJSON(p, obj) {
  ensureDir(p);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// DB helpers
function loadUsers()   { return loadJSON(USERS_PATH, {}); }
function saveUsers(db) { saveJSON(USERS_PATH, db); }

function loadJournal()   { return loadJSON(JOURNAL_PATH, {}); }
function saveJournal(db) { saveJSON(JOURNAL_PATH, db); }

function loadMeta()   { return loadJSON(META_PATH, {}); }
function saveMeta(db) { saveJSON(META_PATH, db); }

function getPromptText() {
  try { return fs.readFileSync(PROMPT_PATH, "utf-8"); }
  catch {
    return "Tu es CoachBot. Réponds en français, brièvement, concrètement, en tutoyant, avec micro‑actions.";
  }
}

// ID court
function uid(prefix="u") {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rnd}`;
}

// ---------------- Plans du jour ----------------
const plans = {
  1:"Clarification des intentions : défi prioritaire, pourquoi c’est important, et ce que ‘réussir’ signifie.",
  2:"Diagnostic : 3 leviers + 3 obstacles.",
  3:"Vision + 3 indicateurs mesurables.",
  4:"Valeurs et motivations.",
  5:"Énergie : estime de soi / amour propre / confiance.",
  6:"Confiance (suite) : preuves, retours, micro‑victoires.",
  7:"Bilan KISS (Keep / Improve / Start / Stop).",
  8:"Nouveau départ : cap & prochaines 48h.",
  9:"Plan simple : 1 action / jour.",
  10:"Préparer un message clé (CNV).",
  11:"Décisions : Stop / Keep / Start.",
  12:"Échelle de responsabilité.",
  13:"Co‑développement éclair.",
  14:"Leadership (Maxwell).",
  15:"Bilan final + plan 30 jours."
};

// ---------------- Migration légère au démarrage ----------------
(function bootstrapFiles(){
  ensureDir(USERS_PATH); ensureDir(JOURNAL_PATH); ensureDir(META_PATH);
  const u = loadUsers(); const j = loadJournal(); const m = loadMeta();
  if (typeof u !== "object" || Array.isArray(u)) saveUsers({});
  if (typeof j !== "object" || Array.isArray(j)) saveJournal({});
  if (typeof m !== "object" || Array.isArray(m)) saveMeta({});
})();

// ---------------- Seed Admin (optionnel) ----------------
(function seedAdmin(){
  const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;

  const users = loadUsers();
  const exists = Object.values(users).find(
    u => u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()
  );
  if (exists) return;

  const id = uid("u");
  users[id] = {
    id,
    email: ADMIN_EMAIL,
    name: ADMIN_NAME || "Admin",
    role: "admin",
    passHash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
    createdAt: new Date().toISOString()
  };
  saveUsers(users);
  console.log("✅ Admin seed créé:", ADMIN_EMAIL);
})();

// ---------------- Auth helpers ----------------
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "unauthorized" });
    const token = h.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const users = loadUsers();
    const user = users[payload.sub];
    if (!user) return res.status(401).json({ error: "unauthorized" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "forbidden" });
  next();
}

// ---------------- IA helpers ----------------
function systemPrompt(name, disc) {
  const base = getPromptText();

  const etiquette = `
[Contexte CoachBot]
- Utilise les formules d’usage islamiques quand c’est pertinent (ex: Salam 3alaykum, in shâ’ Allah, bi idhniLlah, barakAllahu fîk).
- Garde un ton respectueux, concis, orienté micro‑actions (≤ 10 min), avec critère de réussite.
- Tutoiement systématique. Utilise le prénom si connu.

Profil
- Prénom: ${name || "Inconnu"}
- DISC: ${disc || "À déduire"}
`;

  return base + "\n\n" + etiquette;
}

function makeUserPrompt(day, message) {
  const plan = plans[Number(day)] || "Plan non spécifié.";
  return `Plan du jour (J${day}) : ${plan}\n\nMessage utilisateur : ${message}\n\nConsigne : réponds en plusieurs petites bulles (phrases courtes séparées par des sauts de ligne), pas de long paragraphe.`;
}

// Heuristiques prénom / DISC
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

// ---------------- Static (UI) ----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ---------------- Health ----------------
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------------- Auth API ----------------
app.post("/api/auth/register", (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });

  const users = loadUsers();
  const exists = Object.values(users).find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: "email_taken" });

  const id = uid("u");
  users[id] = {
    id,
    email: String(email).trim(),
    name: (name || "").trim() || null,
    role: "user",
    passHash: bcrypt.hashSync(String(password), 10),
    createdAt: new Date().toISOString()
  };
  saveUsers(users);

  // init meta
  const meta = loadMeta();
  meta[id] = { name: users[id].name, disc: null };
  saveMeta(meta);

  const token = signToken(users[id]);
  res.json({ token, user: { id, email: users[id].email, name: users[id].name, role: users[id].role }});
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "missing_fields" });

  const users = loadUsers();
  const user = Object.values(users).find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: "invalid_credentials" });
  if (!bcrypt.compareSync(String(password), user.passHash)) return res.status(401).json({ error: "invalid_credentials" });

  const token = signToken(user);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role }});
});

app.get("/api/me", authMiddleware, (req, res) => {
  const meta = loadMeta()[req.user.id] || { name: req.user.name, disc: null };
  res.json({ user: { id:req.user.id, email:req.user.email, name:req.user.name, role:req.user.role }, meta });
});

// ---------------- Meta (prénom / DISC) ----------------
app.get("/api/meta", authMiddleware, (req, res) => {
  const meta = loadMeta()[req.user.id] || { name: req.user.name, disc: null };
  res.json(meta);
});
app.post("/api/meta", authMiddleware, (req, res) => {
  const meta = loadMeta();
  const curr = meta[req.user.id] || { name: req.user.name || null, disc: null };
  if (req.body?.name) curr.name = String(req.body.name).trim();
  if (req.body?.disc) curr.disc = String(req.body.disc).toUpperCase();
  meta[req.user.id] = curr;
  saveMeta(meta);
  res.json({ success: true, meta: curr });
});

// ---------------- Journal API (par user & par jour) ----------------
function getEntriesFor(userId, day) {
  const db = loadJournal();
  const u = db[userId] || {};
  const arr = u[String(day)];
  return Array.isArray(arr) ? arr : [];
}
function addEntryFor(userId, day, entry) {
  const db = loadJournal();
  if (!db[userId]) db[userId] = {};
  const key = String(day);
  if (!Array.isArray(db[userId][key])) db[userId][key] = [];
  db[userId][key].push(entry);
  saveJournal(db);
}

app.get("/api/journal", authMiddleware, (req, res) => {
  const day = Number(req.query.day || 1);
  res.json(getEntriesFor(req.user.id, day));
});

app.post("/api/journal/save", authMiddleware, (req, res) => {
  const { day = 1, message = "", role = "user" } = req.body || {};
  addEntryFor(req.user.id, day, { role, message, date: new Date().toISOString() });
  res.json({ success: true });
});

// ---------------- Chat (non-stream & stream) ----------------
app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const metaAll = loadMeta();
    const myMeta = metaAll[req.user.id] || { name: req.user.name, disc: null };

    // Heuristiques au vol si inconnus
    if (!myMeta.name) {
      const n = maybeExtractName(message);
      if (n && n.length >= 2) { myMeta.name = n; metaAll[req.user.id] = myMeta; saveMeta(metaAll); }
    }
    if (!myMeta.disc) {
      const d = inferDISC(message);
      if (d) { myMeta.disc = d; metaAll[req.user.id] = myMeta; saveMeta(metaAll); }
    }

    addEntryFor(req.user.id, day, { role: "user", message, date: new Date().toISOString() });

    const system = systemPrompt(myMeta.name, myMeta.disc);
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
      addEntryFor(req.user.id, day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    res.status(400).json({ error: "provider_not_supported" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/chat/stream", authMiddleware, async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};
  const metaAll = loadMeta();
  const myMeta = metaAll[req.user.id] || { name: req.user.name, disc: null };

  // Heuristiques
  if (!myMeta.name) {
    const n = maybeExtractName(message);
    if (n && n.length >= 2) { myMeta.name = n; metaAll[req.user.id] = myMeta; saveMeta(metaAll); }
  }
  if (!myMeta.disc) {
    const d = inferDISC(message);
    if (d) { myMeta.disc = d; metaAll[req.user.id] = myMeta; saveMeta(metaAll); }
  }

  addEntryFor(req.user.id, day, { role: "user", message, date: new Date().toISOString() });

  const system = systemPrompt(myMeta.name, myMeta.disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    if (provider === "anthropic" || provider === "claude") {
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
            // Anthropic incremental text
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              const delta = evt.delta.text || "";
              if (delta) { full += delta; send({ text: delta }); }
            }
          } catch { /* ignore */ }
        }
      }
      if (full) addEntryFor(req.user.id, day, { role: "ai", message: full, date: new Date().toISOString() });
      return end();
    }

    send({ error: "provider_not_supported" }); return end();
  } catch (e) {
    console.error(e);
    send({ error: "server_error" }); return end();
  }
});

// ---------------- Admin API ----------------
app.get("/api/admin/users", authMiddleware, adminOnly, (_req, res) => {
  const users = Object.values(loadUsers()).map(u => ({
    id: u.id, email: u.email, name: u.name || null, role: u.role, createdAt: u.createdAt
  }));
  res.json(users);
});

app.post("/api/admin/user/role", authMiddleware, adminOnly, (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId || !role) return res.status(400).json({ error: "missing_fields" });
  const users = loadUsers();
  if (!users[userId]) return res.status(404).json({ error: "not_found" });
  users[userId].role = role === "admin" ? "admin" : "user";
  saveUsers(users);
  res.json({ success: true });
});

app.get("/api/admin/stats", authMiddleware, adminOnly, (_req, res) => {
  const journal = loadJournal();
  const perDay = [];
  let totalMessages = 0;
  for (let day=1; day<=15; day++) {
    let c = 0;
    for (const userId of Object.keys(journal)) {
      const arr = journal[userId]?.[String(day)];
      if (Array.isArray(arr)) c += arr.length;
    }
    perDay.push({ day, count: c });
    totalMessages += c;
  }
  const totalUsers = Object.keys(loadUsers()).length;
  res.json({ totalUsers, totalMessages, perDay });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur en ligne sur le port ${PORT}`));
