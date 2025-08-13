// server.js — CoachBot multi-utilisateur (JSON + Claude + Auth)
// ES modules
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// ---------------- App & middlewares ----------------
const app = express();
app.use(cors({
  origin: true, // autorise l'origine courante
  credentials: true // pour envoyer/recevoir cookies
}));
app.use(bodyParser.json());
app.use(cookieParser());

// ---------------- Paths / filenames ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Données
const USERS_PATH   = process.env.USERS_PATH   || "/data/users.json";        // { [userId]: {id,email,passHash,name,disc,createdAt} }
const JOURNAL_PATH = process.env.JOURNAL_PATH || "/data/journal.json";      // { [userId]: { [day]: [ {role,message,date} ] } }
const META_PATH    = process.env.META_PATH    || "/data/meta.json";         // { [userId]: {name,disc} } (compat)
const PROMPT_PATH  = process.env.PROMPT_PATH  || path.join(__dirname, "prompt.txt");

// Clés / sécurité
const JWT_SECRET   = process.env.JWT_SECRET   || "change-me-in-render";     // IMPORTANT: mets une vraie valeur en prod
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY || null;
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL    || "claude-3-5-sonnet-20241022";

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

// ---------------- Stockages ----------------
function loadUsers() { return loadJSON(USERS_PATH, {}); }
function saveUsers(u) { saveJSON(USERS_PATH, u); }

function loadJournal() { return loadJSON(JOURNAL_PATH, {}); }
function saveJournal(j) { saveJSON(JOURNAL_PATH, j); }

function loadMeta() { return loadJSON(META_PATH, {}); }
function saveMeta(m) { saveJSON(META_PATH, m); }

// ---------------- Migration douce au démarrage ----------------
(function migrate() {
  // Assurer structures de base
  const users = loadUsers();
  const journal = loadJournal();
  const meta = loadMeta();

  // Anciennes structures possibles : si journal n'est pas objet -> reset
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
    saveJournal({});
  } else {
    // S'assurer que chaque userId -> { day: [] }
    let changed = false;
    for (const uid of Object.keys(journal)) {
      const perUser = journal[uid];
      if (!perUser || typeof perUser !== "object" || Array.isArray(perUser)) {
        journal[uid] = {};
        changed = true;
      } else {
        for (const k of Object.keys(perUser)) {
          const v = perUser[k];
          if (Array.isArray(v)) continue;
          if (v && typeof v === "object") { perUser[k] = [v]; changed = true; }
          else { perUser[k] = []; changed = true; }
        }
      }
    }
    if (changed) saveJournal(journal);
  }

  // meta: s'assurer que c'est { [userId]: {name,disc} }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) saveMeta({});
  // users: objet
  if (!users || typeof users !== "object" || Array.isArray(users)) saveUsers({});
})();

// ---------------- Helpers d'auth ----------------
// JWT light (sans librairie) — signé en HMAC-SHA256 avec WebCrypto (Node 20+)
import crypto from "crypto";

/** Encode Base64URL */
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function signJWT(payload, secret, ttlSec=60*60*24*7) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now()/1000);
  const body = { ...payload, iat: now, exp: now + ttlSec };
  const headB = b64url(JSON.stringify(header));
  const bodyB = b64url(JSON.stringify(body));
  const data = `${headB}.${bodyB}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}
function verifyJWT(token, secret) {
  try {
    const [h,p,s] = token.split(".");
    if (!h||!p||!s) return null;
    const data = `${h}.${p}`;
    const expected = crypto.createHmac("sha256", secret).update(data).digest();
    if (b64url(expected) !== s) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"));
    if (payload.exp && Math.floor(Date.now()/1000) > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function setSessionCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true, // Render est en HTTPS
    path: "/",
    maxAge: 7*24*60*60*1000
  });
}
function clearSessionCookie(res) {
  res.clearCookie("token", { path: "/" });
}

function authRequired(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  if (!token) return res.status(401).json({ error: "auth_required" });
  const payload = verifyJWT(token, JWT_SECRET);
  if (!payload || !payload.sub) return res.status(401).json({ error: "invalid_token" });
  req.userId = payload.sub;
  next();
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

// ---------------- Static UI ----------------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------------- AUTH API ----------------
app.post("/api/auth/register", (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email_password_required" });

  const users = loadUsers();
  const exists = Object.values(users).find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: "email_exists" });

  const id = uuidv4();
  const passHash = bcrypt.hashSync(String(password), 10);
  const user = { id, email: String(email), passHash, name: name || null, disc: null, createdAt: new Date().toISOString() };
  users[id] = user;
  saveUsers(users);

  // init meta compat
  const meta = loadMeta();
  meta[id] = { name: user.name, disc: user.disc };
  saveMeta(meta);

  // init journal
  const journal = loadJournal();
  journal[id] = {};
  saveJournal(journal);

  const token = signJWT({ sub: id }, JWT_SECRET);
  setSessionCookie(res, token);
  res.json({ ok: true, user: { id, email: user.email, name: user.name, disc: user.disc } });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email_password_required" });

  const users = loadUsers();
  const user = Object.values(users).find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: "invalid_credentials" });
  if (!bcrypt.compareSync(String(password), user.passHash)) return res.status(401).json({ error: "invalid_credentials" });

  const token = signJWT({ sub: user.id }, JWT_SECRET);
  setSessionCookie(res, token);
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, disc: user.disc } });
});

app.post("/api/auth/logout", authRequired, (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", authRequired, (req, res) => {
  const users = loadUsers();
  const u = users[req.userId];
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json({ id: u.id, email: u.email, name: u.name, disc: u.disc });
});

// ---------------- Journal API (par utilisateur) ----------------
function getEntries(userId, day) {
  const journal = loadJournal();
  const perUser = journal[userId] || {};
  const val = perUser[String(day)];
  if (Array.isArray(val)) return val;
  if (val && typeof val === "object") return [val];
  return [];
}
function addEntry(userId, day, entry) {
  const journal = loadJournal();
  const perUser = journal[userId] || {};
  const v = perUser[String(day)];
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (v && typeof v === "object") arr = [v];

  arr.push(entry);
  perUser[String(day)] = arr;
  journal[userId] = perUser;
  saveJournal(journal);
}

app.get("/api/journal", authRequired, (req, res) => {
  const day = Number(req.query.day || 1);
  return res.json(getEntries(req.userId, day));
});
app.post("/api/journal/save", authRequired, (req, res) => {
  const { day = 1, message = "", role = "user" } = req.body || {};
  addEntry(req.userId, day, { role, message, date: new Date().toISOString() });
  return res.json({ success: true });
});

// ---------------- Meta API (prénom / DISC) ----------------
app.get("/api/meta", authRequired, (_req, res) => {
  const meta = loadMeta();
  const m = meta[_req.userId] || { name: null, disc: null };
  res.json(m);
});
app.post("/api/meta", authRequired, (req, res) => {
  const meta = loadMeta();
  meta[req.userId] = {
    name: req.body?.name ? String(req.body.name).trim() : (meta[req.userId]?.name ?? null),
    disc: req.body?.disc ? String(req.body.disc).toUpperCase() : (meta[req.userId]?.disc ?? null)
  };
  // sync dans users aussi
  const users = loadUsers();
  if (users[req.userId]) {
    users[req.userId].name = meta[req.userId].name;
    users[req.userId].disc = meta[req.userId].disc;
    saveUsers(users);
  }
  saveMeta(meta);
  res.json({ success: true, meta: meta[req.userId] });
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
app.post("/api/chat", authRequired, async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const users = loadUsers();
    const u = users[req.userId] || {};
    const metaAll = loadMeta();
    const meta = metaAll[req.userId] || { name: u.name ?? null, disc: u.disc ?? null };

    // Heuristiques
    if (!meta.name) {
      const n = maybeExtractName(message);
      if (n && n.length >= 2) { meta.name = n; metaAll[req.userId] = meta; saveMeta(metaAll); users[req.userId].name = n; saveUsers(users); }
    }
    if (!meta.disc) {
      const d = inferDISC(message);
      if (d) { meta.disc = d; metaAll[req.userId] = meta; saveMeta(metaAll); users[req.userId].disc = d; saveUsers(users); }
    }

    addEntry(req.userId, day, { role: "user", message, date: new Date().toISOString() });

    const system = systemPrompt(meta.name, meta.disc);
    const user   = makeUserPrompt(day, message);

    if ((provider === "anthropic" || provider === "claude") && CLAUDE_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": CLAUDE_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
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
      addEntry(req.userId, day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    return res.status(400).json({ error: "Fournisseur non disponible ou clé manquante" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ---------------- Chat streaming (SSE) ----------------
app.post("/api/chat/stream", authRequired, async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};
  const users = loadUsers();
  const u = users[req.userId] || {};
  const metaAll = loadMeta();
  const meta = metaAll[req.userId] || { name: u.name ?? null, disc: u.disc ?? null };

  if (!meta.name) {
    const n = maybeExtractName(message);
    if (n && n.length >= 2) { meta.name = n; metaAll[req.userId] = meta; saveMeta(metaAll); users[req.userId].name = n; saveUsers(users); }
  }
  if (!meta.disc) {
    const d = inferDISC(message);
    if (d) { meta.disc = d; metaAll[req.userId] = meta; saveMeta(metaAll); users[req.userId].disc = d; saveUsers(users); }
  }

  addEntry(req.userId, day, { role: "user", message, date: new Date().toISOString() });

  const system = systemPrompt(meta.name, meta.disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    if ((provider === "anthropic" || provider === "claude") && CLAUDE_KEY) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": CLAUDE_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
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
          } catch {}
        }
      }
      if (full) addEntry(req.userId, day, { role: "ai", message: full, date: new Date().toISOString() });
      return end();
    }

    send({ error: "Fournisseur non disponible ou clé manquante" }); return end();
  } catch (e) {
    console.error(e);
    send({ error: "Erreur serveur" }); return end();
  }
});

// ---------------- Health / Ready / Version ----------------
app.get("/healthz", (_req, res) => {
  const dbUsers   = fs.existsSync(USERS_PATH);
  const dbJournal = fs.existsSync(JOURNAL_PATH);
  res.status(200).json({
    ok: true,
    users: dbUsers ? "ok" : "missing",
    journal: dbJournal ? "ok" : "missing"
  });
});
app.get("/readyz", (_req, res) => res.status(200).json({ ready: true }));
app.get("/version", (_req, res) => {
  res.json({
    name: "coachbot",
    env: process.env.NODE_ENV || "production",
    model: CLAUDE_MODEL,
    time: new Date().toISOString()
  });
});

// ---------------- DEBUG (token optionnel) ----------------
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;
function guardDebug(req, res) {
  if (!DEBUG_TOKEN) return true;
  const t = (req.query.token || req.headers["x-debug-token"] || "").toString();
  if (t !== DEBUG_TOKEN) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}
app.get("/debug/ls", (req, res) => {
  if (!guardDebug(req, res)) return;
  try {
    const entries = fs.readdirSync("/data").map(name => {
      const st = fs.statSync(path.join("/data", name));
      return { name, size: st.size, mtime: st.mtime };
    });
    res.json({ path: "/data", entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/debug/journal", (req, res) => {
  if (!guardDebug(req, res)) return;
  res.json({ journal: loadJournal(), JOURNAL_PATH });
});
app.get("/debug/meta", (req, res) => {
  if (!guardDebug(req, res)) return;
  res.json({ meta: loadMeta(), META_PATH });
});
app.get("/debug/users", (req, res) => {
  if (!guardDebug(req, res)) return;
  const users = loadUsers();
  // Ne pas exposer passHash
  const safe = Object.fromEntries(Object.entries(users).map(([k,v]) => [k, { id: v.id, email: v.email, name: v.name, disc: v.disc, createdAt: v.createdAt }]));
  res.json({ users: safe, USERS_PATH });
});
app.post("/debug/reset", (req, res) => {
  if (!guardDebug(req, res)) return;
  const what = (req.body?.what || "").toString();
  if (what === "journal") saveJSON(JOURNAL_PATH, {});
  else if (what === "users") saveJSON(USERS_PATH, {});
  else if (what === "meta") saveJSON(META_PATH, {});
  else return res.status(400).json({ error: "what must be 'journal' or 'users' or 'meta'" });
  res.json({ success: true });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur en ligne sur le port ${PORT}`));
