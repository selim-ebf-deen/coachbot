// server.js — CoachBot complet (multi‑utilisateur + Claude + Admin)
// ES modules
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

dotenv.config();

// ---------------- App & middlewares ----------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// ---------------- Paths / filenames ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fichiers (JSON) — par défaut /data pour persistance Render
const USERS_PATH   = process.env.USERS_PATH   || "/data/users.json";
const JOURNAL_PATH = process.env.JOURNAL_PATH || "/data/journal.json";
const META_PATH    = process.env.META_PATH    || "/data/meta.json";
const PROMPT_PATH  = process.env.PROMPT_PATH  || path.join(__dirname, "prompt.txt");

const JWT_SECRET   = process.env.JWT_SECRET || "change_me_now";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

// ---------------- Utils: files & JSON ----------------
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadJSON(p, fallback) {
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(p, obj) { ensureDir(p); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function getPromptText() {
  try { return fs.readFileSync(PROMPT_PATH, "utf-8"); }
  catch {
    return (
      "Tu es CoachBot, un coach personnel bienveillant, direct et orienté résultats. " +
      "Toujours tutoyer l’utilisateur et utiliser son prénom si connu. Réponses courtes, " +
      "concrètes, 1–2 conseils actionnables ≤24h, 1 micro‑action de 10 min, 1 critère de réussite."
    );
  }
}

// ---------------- In‑memory helpers vers fichiers ----------------
function loadUsers()   { return loadJSON(USERS_PATH, {}); }
function saveUsers(u)  { saveJSON(USERS_PATH, u); }

function loadJournal() { return loadJSON(JOURNAL_PATH, {}); }
function saveJournal(j){ saveJSON(JOURNAL_PATH, j); }

function loadMetaAll() { return loadJSON(META_PATH, {}); }                 // { userId: {name, disc} }
function saveMetaAll(m){ saveJSON(META_PATH, m); }

// Retourne tableau d’entrées pour un userId+day
function getEntries(userId, day) {
  const db = loadJournal();
  const u = db[userId] || {};
  const val = u[day];
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object") return [val]; // compat anciens formats
  return [];
}
function addEntry(userId, day, entry) {
  const db = loadJournal();
  if (!db[userId] || typeof db[userId] !== "object") db[userId] = {};
  const val = db[userId][day];
  let arr;
  if (Array.isArray(val)) arr = val;
  else if (val && typeof val === "object") arr = [val];
  else arr = [];
  arr.push(entry);
  db[userId][day] = arr;
  saveJournal(db);
}

// Méta prénom/DISC par user
function getMeta(userId) {
  const m = loadMetaAll();
  return m[userId] || { name: null, disc: null };
}
function setMeta(userId, metaPatch) {
  const m = loadMetaAll();
  if (!m[userId]) m[userId] = { name: null, disc: null };
  if (typeof metaPatch?.name === "string") m[userId].name = metaPatch.name.trim();
  if (typeof metaPatch?.disc === "string") m[userId].disc = metaPatch.disc.toUpperCase();
  saveMetaAll(m);
  return m[userId];
}

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

// ---------------- Auth helpers ----------------
function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role || "user" },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}
function authMiddleware(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Non authentifié" });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { sub, role, iat, exp }
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide/expiré" });
  }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Accès admin requis" });
  next();
}

// ---------------- Seed admin (robuste) ----------------
async function seedAdminIfNeeded() {
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
  const ADMIN_NAME = process.env.ADMIN_NAME || "Admin";

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log("ℹ️  Seed admin ignoré (ADMIN_EMAIL ou ADMIN_PASSWORD manquant).");
    return;
  }
  const users = loadUsers();
  const targetEmail = String(ADMIN_EMAIL).toLowerCase();
  const existing = Object.values(users).find(
    (u) => u?.email && String(u.email).toLowerCase() === targetEmail
  );
  if (existing) {
    if (existing.role !== "admin") {
      existing.role = "admin";
      saveUsers(users);
      console.log(`🔐 Admin déjà existant, rôle mis à jour: ${existing.email}`);
    } else {
      console.log(`🔐 Admin déjà existant: ${existing.email}`);
    }
    return;
  }
  const id = "u_" + Math.random().toString(36).slice(2, 10);
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(ADMIN_PASSWORD, salt);
  users[id] = {
    id,
    email: ADMIN_EMAIL,
    name: ADMIN_NAME,
    role: "admin",
    passwordHash: hash,
    createdAt: new Date().toISOString()
  };
  saveUsers(users);
  console.log(`✅ Admin seedé: ${ADMIN_EMAIL}`);
}
seedAdminIfNeeded().catch((e) => console.error("Seed admin error:", e));

// ---------------- Static files ----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/admin", (_req, res) => {
  const adminPath = path.join(__dirname, "public", "admin.html");
  if (fs.existsSync(adminPath)) return res.sendFile(adminPath);
  res.status(404).send("Admin UI non déployée.");
});

// ---------------- Auth endpoints ----------------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    const users = loadUsers();
    const exists = Object.values(users).find(
      (u) => u?.email && String(u.email).toLowerCase() === String(email).toLowerCase()
    );
    if (exists) return res.status(400).json({ error: "Email déjà utilisé" });

    const id = "u_" + Math.random().toString(36).slice(2, 10);
    const hash = await bcrypt.hash(String(password), 10);
    users[id] = {
      id,
      email: String(email).toLowerCase(),
      name: name?.trim() || null,
      role: "user",
      passwordHash: hash,
      createdAt: new Date().toISOString()
    };
    saveUsers(users);

    // Initialiser méta
    setMeta(id, { name: users[id].name || null });

    const token = signToken(users[id]);
    res.json({ token, user: { id, email: users[id].email, name: users[id].name, role: "user" } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    const users = loadUsers();
    const user = Object.values(users).find(
      (u) => u?.email && String(u.email).toLowerCase() === String(email).toLowerCase()
    );
    if (!user) return res.status(401).json({ error: "Identifiants invalides" });

    const ok = await bcrypt.compare(String(password), user.passwordHash || "");
    if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

    const token = signToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/me", authMiddleware, (req, res) => {
  const users = loadUsers();
  const user = users[req.user.sub];
  if (!user) return res.status(401).json({ error: "Utilisateur introuvable" });
  const meta = getMeta(user.id);
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, meta });
});

// ---------------- Journal API (protégée) ----------------
app.get("/api/journal", authMiddleware, (req, res) => {
  const day = Number(req.query.day || 1);
  return res.json(getEntries(req.user.sub, day));
});
app.post("/api/journal/save", authMiddleware, (req, res) => {
  const { day = 1, message = "", role = "user" } = req.body || {};
  addEntry(req.user.sub, day, { role, message, date: new Date().toISOString() });
  return res.json({ success: true });
});

// ---------------- Meta API (protégée) ----------------
app.get("/api/meta", authMiddleware, (_req, res) => {
  res.json(getMeta(_req.user.sub));
});
app.post("/api/meta", authMiddleware, (req, res) => {
  const meta = setMeta(req.user.sub, { name: req.body?.name, disc: req.body?.disc });
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

// ---------------- Chat (non‑stream) ----------------
app.post("/api/chat", authMiddleware, async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const meta = getMeta(req.user.sub);

    // Heuristiques prénom / DISC
    if (!meta.name) {
      const n = maybeExtractName(message);
      if (n && n.length >= 2) setMeta(req.user.sub, { name: n });
    }
    if (!meta.disc) {
      const d = inferDISC(message);
      if (d) setMeta(req.user.sub, { disc: d });
    }

    addEntry(req.user.sub, day, { role: "user", message, date: new Date().toISOString() });

    const system = systemPrompt(getMeta(req.user.sub).name, getMeta(req.user.sub).disc);
    const user   = makeUserPrompt(day, message);

    if ((provider === "anthropic" || provider === "claude")) {
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
          model: ANTHROPIC_MODEL,
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
      addEntry(req.user.sub, day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    return res.status(400).json({ error: "Fournisseur inconnu ou non activé" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ---------------- Chat streaming (SSE) ----------------
app.post("/api/chat/stream", authMiddleware, async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};
  const meta0 = getMeta(req.user.sub);

  // Heuristiques
  if (!meta0.name) {
    const n = maybeExtractName(message);
    if (n && n.length >= 2) setMeta(req.user.sub, { name: n });
  }
  if (!meta0.disc) {
    const d = inferDISC(message);
    if (d) setMeta(req.user.sub, { disc: d });
  }

  addEntry(req.user.sub, day, { role: "user", message, date: new Date().toISOString() });

  const meta = getMeta(req.user.sub);
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
      if (!process.env.ANTHROPIC_API_KEY) { send({ error: "ANTHROPIC_API_KEY manquante" }); return end(); }

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
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
      if (full) addEntry(req.user.sub, day, { role: "ai", message: full, date: new Date().toISOString() });
      return end();
    }

    send({ error: "Fournisseur inconnu ou non activé" }); return end();
  } catch (e) {
    console.error(e);
    send({ error: "Erreur serveur" }); return end();
  }
});

// ---------------- Admin API (protégée + rôle admin) ----------------
app.get("/api/admin/stats", authMiddleware, adminOnly, (_req, res) => {
  const users = loadUsers();
  const journal = loadJournal();

  const nbUsers = Object.keys(users).length;
  const nbEntries = Object.values(journal).reduce((acc, days) => {
    if (!days || typeof days !== "object") return acc;
    return acc + Object.values(days).reduce((a, arr) => a + (Array.isArray(arr) ? arr.length : 0), 0);
  }, 0);

  res.json({
    users: nbUsers,
    entries: nbEntries,
  });
});

app.get("/api/admin/users", authMiddleware, adminOnly, (_req, res) => {
  const users = loadUsers();
  const list = Object.values(users).map(u => ({
    id: u.id, email: u.email, name: u.name || null, role: u.role || "user", createdAt: u.createdAt
  }));
  res.json(list);
});

app.post("/api/admin/user/role", authMiddleware, adminOnly, (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId || !role) return res.status(400).json({ error: "userId et role requis" });
  const users = loadUsers();
  if (!users[userId]) return res.status(404).json({ error: "Utilisateur introuvable" });
  users[userId].role = role;
  saveUsers(users);
  res.json({ success: true });
});

// ---------------- Health endpoints ----------------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/healthz/ready", (_req, res) => {
  const okClaude = !!process.env.ANTHROPIC_API_KEY;
  res.json({ ok: true, claude: okClaude, time: new Date().toISOString() });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur en ligne sur le port ${PORT}`));
