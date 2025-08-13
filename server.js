// server.js — CoachBot complet (auth + multi-user + admin + Claude streaming)
// Node 20 ESM

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

// ---------- App ----------
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const USERS_PATH   = process.env.USERS_PATH   || "/data/users.json";
const JOURNAL_PATH = process.env.JOURNAL_PATH || "/data/journal.json";
const META_PATH    = process.env.META_PATH    || "/data/meta.json"; // legacy global (non utilisé pour multi-user)
const PROMPT_PATH  = process.env.PROMPT_PATH  || path.join(__dirname, "prompt.txt");

// ---------- Helpers fichiers ----------
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function saveJSON(p, obj) { ensureDir(p); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// Stockages
function loadUsers(){ return loadJSON(USERS_PATH, {}); }
function saveUsers(u){ saveJSON(USERS_PATH, u); }
function loadJournal(){ return loadJSON(JOURNAL_PATH, {}); }
function saveJournal(db){ saveJSON(JOURNAL_PATH, db); }

// Prompt système
function getPromptText(){
  try { return fs.readFileSync(PROMPT_PATH, "utf-8"); }
  catch {
    return "Tu es CoachBot. Réponds en français, brièvement, concrètement, en tutoyant.";
  }
}

// ---------- Migrations douces ----------
(function migrate() {
  const db = loadJournal();
  let changed = false;
  // On s'assure que chaque clé jour (1..15) est un tableau
  for (const k of Object.keys(db)) {
    const v = db[k];
    if (Array.isArray(v)) continue;
    if (v && typeof v === "object") { db[k] = [v]; changed = true; }
    else { db[k] = []; changed = true; }
  }
  if (changed) saveJournal(db);

  // Seed admin si variables présentes
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const users = loadUsers();
    const existing = Object.values(users).find(u => u.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase());
    if (!existing) {
      const id = "u_" + Math.random().toString(36).slice(2, 10);
      const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      users[id] = {
        id,
        email: ADMIN_EMAIL.toLowerCase(),
        name: "Admin",
        role: "admin",
        createdAt: new Date().toISOString(),
        passwordHash
      };
      saveUsers(users);
      console.log("Seed admin créé pour", ADMIN_EMAIL);
    }
  }
})();

// ---------- Middlewares auth ----------
function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { sub: userId, role, iat, exp }
    next();
  } catch {
    return res.status(401).json({ error: "bad_token" });
  }
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "forbidden" });
    next();
  });
}

// ---------- Heuristiques prénom & DISC ----------
function maybeExtractName(text) {
  const t = (text || "").trim();
  let m = t.match(/je m(?:'|e)appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
        || t.match(/moi c['’]est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
        || (t.split(/\s+/).length === 1 ? [null, t] : null);
  const name = m ? m[1].trim().replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g,"") : null;
  return name || null;
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

// ---------- Plans jour ----------
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

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

// ---------- Health ----------
app.get("/healthz", (_req, res) => res.json({ ok:true }));

// ---------- Auth API ----------
app.post("/api/auth/register", (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error:"missing_fields" });
  const users = loadUsers();
  const exists = Object.values(users).find(u => u.email?.toLowerCase() === String(email).toLowerCase());
  if (exists) return res.status(409).json({ error:"email_taken" });

  const id = "u_" + Math.random().toString(36).slice(2, 10);
  const passwordHash = bcrypt.hashSync(password, 10);
  users[id] = {
    id,
    email: String(email).toLowerCase(),
    name: name ? String(name).trim() : null,
    role: "user",
    createdAt: new Date().toISOString(),
    passwordHash
  };
  saveUsers(users);

  const token = jwt.sign({ sub:id, role:"user" }, process.env.JWT_SECRET, { expiresIn:"30d" });
  res.json({ token, user: { id, email: users[id].email, name: users[id].name, role: "user" }});
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error:"missing_fields" });
  const users = loadUsers();
  const user = Object.values(users).find(u => u.email?.toLowerCase() === String(email).toLowerCase());
  if (!user || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error:"bad_credentials" });

  const token = jwt.sign({ sub:user.id, role:user.role }, process.env.JWT_SECRET, { expiresIn:"30d" });
  res.json({ token, user: { id:user.id, email:user.email, name:user.name, role:user.role }});
});

app.get("/api/me", requireAuth, (req, res) => {
  const users = loadUsers();
  const u = users[req.user.sub];
  if (!u) return res.status(404).json({ error:"not_found" });
  res.json({ user: { id:u.id, email:u.email, name:u.name, role:u.role } });
});

// ---------- Journal API (par user & jour) ----------
app.get("/api/journal", requireAuth, (req, res) => {
  const day = String(req.query.day || "1");
  const db  = loadJournal();
  const arr = Array.isArray(db[day]) ? db[day] : [];
  const mine = arr.filter(m => m.userId === req.user.sub);
  res.json(mine);
});

app.post("/api/journal/save", requireAuth, (req, res) => {
  const { day=1, message="", role="user" } = req.body || {};
  const d = String(day);
  const db = loadJournal();
  const arr = Array.isArray(db[d]) ? db[d] : [];
  arr.push({ role, message, userId: req.user.sub, date: new Date().toISOString() });
  db[d] = arr;
  saveJournal(db);
  res.json({ success:true });
});

// ---------- IA (Claude) ----------
function systemPrompt(name, disc) {
  const base = getPromptText();
  const note = `\n\n[Contexte CoachBot]\nPrénom: ${name||"Inconnu"}\nDISC: ${disc||"À déduire"}\n` +
               `Rappels: réponses courtes, concrètes, micro‑action 10 min, critère de réussite, tutoiement.`;
  return base + note;
}
function makeUserPrompt(day, message) {
  const plan = plans[Number(day)] || "Plan non spécifié.";
  return `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;
}

app.post("/api/chat/stream", requireAuth, async (req, res) => {
  const { message, day=1, provider="anthropic" } = req.body || {};
  const users = loadUsers();
  const me = users[req.user.sub];

  // heuristiques nom / DISC
  let { name } = me || {};
  if (!name) {
    const n = maybeExtractName(message);
    if (n && me) { me.name = n; saveUsers(users); name = n; }
  }
  let disc = me?.disc || null;
  if (!disc) {
    const d = inferDISC(message);
    if (d && me) { me.disc = d; saveUsers(users); disc = d; }
  }

  // log user message
  {
    const db = loadJournal();
    const dkey = String(day);
    const arr = Array.isArray(db[dkey]) ? db[dkey] : [];
    arr.push({ role:"user", message, userId:req.user.sub, date: new Date().toISOString() });
    db[dkey] = arr;
    saveJournal(db);
  }

  const system = systemPrompt(name, disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    if ((provider === "anthropic" || provider === "claude")) {
      if (!process.env.ANTHROPIC_API_KEY) { send({ error:"ANTHROPIC_API_KEY manquante" }); return end(); }

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
          system, messages: [{ role:"user", content:user }]
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
          if (payload === "[DONE]") break;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              const delta = evt.delta.text || "";
              if (delta) { full += delta; send({ text: delta }); }
            }
          } catch {}
        }
      }
      if (full) {
        const db = loadJournal();
        const dkey = String(day);
        const arr = Array.isArray(db[dkey]) ? db[dkey] : [];
        arr.push({ role:"ai", message: full, userId: req.user.sub, date: new Date().toISOString() });
        db[dkey] = arr;
        saveJournal(db);
      }
      return end();
    }

    send({ error:"provider_not_enabled" }); return end();
  } catch (e) {
    console.error(e);
    send({ error:"server_error" }); return end();
  }
});

// ---------- Admin API ----------
app.get("/api/admin/users", requireAdmin, (_req, res) => {
  const u = loadUsers();
  res.json(Object.values(u));
});

app.post("/api/admin/user/role", requireAdmin, (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId || !role) return res.status(400).json({ error:"missing" });
  const u = loadUsers();
  if (!u[userId]) return res.status(404).json({ error:"not_found" });
  u[userId].role = role === "admin" ? "admin" : "user";
  saveUsers(u);
  res.json({ success:true });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  try {
    const users = loadUsers();
    const journal = loadJournal();

    const totalUsers = Object.values(users).filter(
      u => u && typeof u === "object" && u.email
    ).length;

    let totalMessages = 0;
    const perDay = [];
    for (let d=1; d<=15; d++){
      const arr = Array.isArray(journal[String(d)]) ? journal[String(d)] : [];
      totalMessages += arr.length;
      perDay.push({ day:d, count: arr.length });
    }
    res.json({ totalUsers, totalMessages, perDay });
  } catch (e) {
    console.error("admin/stats error:", e);
    res.status(500).json({ error:"stats_failed" });
  }
});

app.post("/api/admin/repair", requireAdmin, (_req, res) => {
  try {
    const users = loadUsers();
    let changed = false;
    const fixed = {};
    for (const [id, u] of Object.entries(users || {})) {
      if (!u || typeof u !== "object") { changed = true; continue; }
      const email = (u.email || "").toLowerCase().trim();
      if (!id || !email) { changed = true; continue; }
      fixed[id] = {
        id,
        email,
        name: (u.name || "").trim() || null,
        role: u.role === "admin" ? "admin" : "user",
        createdAt: u.createdAt || new Date().toISOString(),
        passwordHash: u.passwordHash || null,
        disc: u.disc || null
      };
    }
    if (changed) saveUsers(fixed);
    res.json({ success:true, before:Object.keys(users||{}).length, after:Object.keys(fixed).length, changed });
  } catch (e) {
    console.error("admin/repair error:", e);
    res.status(500).json({ error:"repair_failed" });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur en ligne sur le port ${PORT}`));
