// server.js — CoachBot multi‑utilisateur + Admin + Claude streaming
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

// ---------- App ----------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR      = "/data";
const USERS_PATH    = process.env.USERS_PATH    || path.join(DATA_DIR, "users.json");
const JOURNAL_PATH  = process.env.JOURNAL_PATH  || path.join(DATA_DIR, "journal.json");
const META_PATH     = process.env.META_PATH     || path.join(DATA_DIR, "meta.json");
const PROMPT_PATH   = process.env.PROMPT_PATH   || path.join(__dirname, "prompt.txt");

const JWT_SECRET    = process.env.JWT_SECRET || "change_me_please";

// ---------- FS helpers ----------
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function saveJSON(p, obj) { ensureDir(p); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function getPromptText() {
  try { return fs.readFileSync(PROMPT_PATH, "utf-8"); }
  catch { return "Tu es CoachBot. Réponds en français, brièvement, concrètement, en tutoyant."; }
}

// ---------- Stores (persistées) ----------
function loadUsers()   { return loadJSON(USERS_PATH, {}); }
function saveUsers(db) { saveJSON(USERS_PATH, db); }

function loadJournal()   { return loadJSON(JOURNAL_PATH, {}); }        // { userId: { "1": [..], ... } }
function saveJournal(db) { saveJSON(JOURNAL_PATH, db); }

function loadMeta()   { return loadJSON(META_PATH, {}); }              // { userId: { name, disc } }
function saveMeta(db) { saveJSON(META_PATH, db); }

// ---------- Utils ----------
function uuid() {
  return "u_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function inferDISC(text) {
  const t = (text || "").trim();
  const ex  = (t.match(/!/g)||[]).length;
  const hasCaps = /[A-Z]{3,}/.test(t);
  const hasNums = /\d/.test(t);
  const asksDetail  = /(détail|exact|précis|critère|mesurable|plan|checklist)/i.test(t);
  const caresPeople = /(écoute|relation|aider|ensemble|émotion|ressenti|bienveillance)/i.test(t);
  const wantsAction = /(action|résultat|vite|maintenant|objectif|deadline|priorit)/i.test(t);

  if (wantsAction && (ex>0 || hasCaps)) return "D";
  if (ex>1 || /cool|idée|créatif|enthous|fun/i.test(t)) return "I";
  if (caresPeople || /calme|rassure|routine|habitude/i.test(t)) return "S";
  if (asksDetail || hasNums || t.length>240) return "C";
  return null;
}
function maybeExtractName(text) {
  const t = (text || "").trim();
  let m = t.match(/je m(?:'|e)appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
       || t.match(/moi c['’]est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
       || (t.split(/\s+/).length === 1 ? [null, t] : null);
  return m ? m[1].trim().replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g,"") : null;
}

// ---------- Plans ----------
const PLANS = {
  1:"Clarification des intentions : précise le défi prioritaire à résoudre en 15 jours, pourquoi c’est important, et ce que « réussir » signifie concrètement.",
  2:"Diagnostic de la situation actuelle : état des lieux, 3 leviers, 3 obstacles.",
  3:"Vision et critères de réussite : issue idéale + 3 indicateurs.",
  4:"Valeurs et motivations : aligne objectifs et valeurs.",
  5:"Énergie : estime de soi / amour propre / confiance (3 niveaux).",
  6:"Confiance (suite) : preuves, retours, micro‑victoires.",
  7:"Bilan intermédiaire KISS (Keep / Improve / Start / Stop).",
  8:"Nouveau départ : cap et prochaines 48h.",
  9:"Plan d’action simple : 1 chose / jour.",
  10:"CNV : préparer un message clé.",
  11:"Décisions : Stop / Keep / Start.",
  12:"Échelle de responsabilité : au‑dessus de la ligne.",
  13:"Co‑développement éclair (pairing).",
  14:"Leadership (Maxwell).",
  15:"Bilan final + plan 30 jours."
};

// ---------- Serve static ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req,res)=> res.sendFile(path.join(__dirname,"public","index.html")));

// ---------- Health ----------
app.get("/healthz", (_req,res)=> res.json({ ok:true, time:new Date().toISOString() }));

// ---------- Auth middleware ----------
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if(!m) return res.status(401).json({ error:"Unauthorized" });
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    req.user = payload; // { id, email, role }
    return next();
  } catch {
    return res.status(401).json({ error:"Unauthorized" });
  }
}

function adminOnly(req, res, next) {
  if(req.user?.role !== "admin") return res.status(403).json({ error:"Forbidden" });
  next();
}

// ---------- Seed admin (optionnel via env) ----------
(function seedAdmin(){
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const ADMIN_NAME = process.env.ADMIN_NAME || "Admin";

  if(!ADMIN_EMAIL || !ADMIN_PASSWORD) return; // pas de seed si non fournis

  const users = loadUsers();
  const existing = Object.values(users).find(u => u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  if(!existing){
    const id = uuid();
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    users[id] = { id, email: ADMIN_EMAIL, passwordHash: hash, name: ADMIN_NAME, role:"admin", createdAt: new Date().toISOString() };
    saveUsers(users);

    const meta = loadMeta();
    meta[id] = { name: ADMIN_NAME, disc: null };
    saveMeta(meta);

    console.log("Seeded admin:", ADMIN_EMAIL);
  }
})();

// ---------- Auth routes ----------
app.post("/api/auth/register", async (req, res) => {
  try{
    const { email, password, name } = req.body || {};
    if(!email || !password) return res.status(400).json({ error:"Email et mot de passe requis" });

    const users = loadUsers();
    const exists = Object.values(users).find(u => u.email.toLowerCase() === String(email).toLowerCase());
    if(exists) return res.status(409).json({ error:"Email déjà utilisé" });

    const id = uuid();
    const hash = await bcrypt.hash(password, 10);
    users[id] = { id, email: String(email).toLowerCase(), passwordHash: hash, name: name||null, role:"user", createdAt: new Date().toISOString() };
    saveUsers(users);

    const meta = loadMeta(); meta[id] = { name: name||null, disc: null }; saveMeta(meta);

    const token = jwt.sign({ id, email: users[id].email, role: users[id].role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id, email: users[id].email, name: users[id].name, role: users[id].role } });
  }catch(e){ console.error(e); res.status(500).json({ error:"Server error" }); }
});

app.post("/api/auth/login", async (req, res) => {
  try{
    const { email, password } = req.body || {};
    if(!email || !password) return res.status(400).json({ error:"Email et mot de passe requis" });

    const users = loadUsers();
    const user = Object.values(users).find(u => u.email.toLowerCase() === String(email).toLowerCase());
    if(!user) return res.status(401).json({ error:"Identifiants invalides" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if(!ok) return res.status(401).json({ error:"Identifiants invalides" });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  }catch(e){ console.error(e); res.status(500).json({ error:"Server error" }); }
});

app.get("/api/me", auth, (req, res) => {
  const users = loadUsers();
  const user = users[req.user.id];
  if(!user) return res.status(401).json({ error:"Unauthorized" });

  const meta = loadMeta()[req.user.id] || { name: user.name||null, disc: null };
  res.json({ user: { id:user.id, email:user.email, name:user.name, role:user.role }, meta });
});

// ---------- Journal & Meta (par user) ----------
function getEntries(userId, day) {
  const db = loadJournal();
  const u = db[userId] || {};
  const raw = u[String(day)];
  if(Array.isArray(raw)) return raw;
  if(raw && typeof raw==="object") return [raw];
  return [];
}
function addEntry(userId, day, entry){
  const db = loadJournal();
  if(!db[userId]) db[userId]={};
  const key = String(day);
  const prev = db[userId][key];
  let arr = Array.isArray(prev) ? prev : (prev && typeof prev==="object" ? [prev] : []);
  arr.push(entry);
  db[userId][key] = arr;
  saveJournal(db);
}

app.get("/api/journal", auth, (req, res) => {
  const day = Number(req.query.day||1);
  return res.json(getEntries(req.user.id, day));
});
app.post("/api/journal/save", auth, (req, res) => {
  const { day=1, message="", role="user" } = req.body || {};
  addEntry(req.user.id, day, { role, message, date:new Date().toISOString() });
  return res.json({ success:true });
});

app.get("/api/meta", auth, (req,res)=>{
  const meta = loadMeta()[req.user.id] || { name:null, disc:null };
  res.json(meta);
});
app.post("/api/meta", auth, (req,res)=>{
  const metaDb = loadMeta();
  const current = metaDb[req.user.id] || { name:null, disc:null };
  if(req.body?.name) current.name = String(req.body.name).trim();
  if(req.body?.disc) current.disc = String(req.body.disc).toUpperCase();
  metaDb[req.user.id] = current;
  saveMeta(metaDb);
  res.json({ success:true, meta: current });
});

// ---------- IA prompts ----------
function systemPrompt(name, disc) {
  const base = getPromptText();
  const note = `

[Contexte CoachBot]
Prénom: ${name || "Inconnu"}
DISC: ${disc || "À déduire"}
Rappels: réponses courtes, concrètes, micro‑action 10 min, critère de réussite, tutoiement.`;
  return base + note;
}
function makeUserPrompt(day, message){
  const plan = PLANS[Number(day)] || "Plan non spécifié.";
  return `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;
}

// ---------- Chat non‑stream ----------
app.post("/api/chat", auth, async (req, res) => {
  try{
    const { message, day=1, provider="anthropic" } = req.body || {};
    const metaDb = loadMeta();
    const userMeta = metaDb[req.user.id] || { name:null, disc:null };

    // heuristiques prénom / DISC
    if(!userMeta.name){
      const n = maybeExtractName(message);
      if(n && n.length>=2){ userMeta.name = n; metaDb[req.user.id] = userMeta; saveMeta(metaDb); }
    }
    if(!userMeta.disc){
      const d = inferDISC(message);
      if(d){ userMeta.disc = d; metaDb[req.user.id] = userMeta; saveMeta(metaDb); }
    }

    addEntry(req.user.id, day, { role:"user", message, date:new Date().toISOString() });

    const system = systemPrompt(userMeta.name, userMeta.disc);
    const user   = makeUserPrompt(day, message);

    if(provider==="anthropic" || provider==="claude"){
      if(!process.env.ANTHROPIC_API_KEY)
        return res.status(500).json({ error:"ANTHROPIC_API_KEY manquante" });

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4,
          system,
          messages:[{ role:"user", content:user }]
        })
      });

      const text = await r.text();
      let data; try{ data = JSON.parse(text); }catch{ data = null; }
      if(!r.ok){
        console.error("Claude error:", r.status, text);
        return res.status(500).json({ error:`Claude error ${r.status}`, details:text });
      }
      const reply = data?.content?.[0]?.text || "Je n’ai pas compris, peux‑tu reformuler ?";
      addEntry(req.user.id, day, { role:"ai", message:reply, date:new Date().toISOString() });
      return res.json({ reply });
    }
    res.status(400).json({ error:"Fournisseur inconnu ou non activé" });
  }catch(e){ console.error(e); res.status(500).json({ error:"Erreur serveur" }); }
});

// ---------- Chat streaming (Claude) ----------
app.post("/api/chat/stream", auth, async (req, res) => {
  const { message, day=1, provider="anthropic" } = req.body || {};
  const metaDb = loadMeta();
  const userMeta = metaDb[req.user.id] || { name:null, disc:null };

  if(!userMeta.name){
    const n = maybeExtractName(message);
    if(n && n.length>=2){ userMeta.name = n; metaDb[req.user.id] = userMeta; saveMeta(metaDb); }
  }
  if(!userMeta.disc){
    const d = inferDISC(message);
    if(d){ userMeta.disc = d; metaDb[req.user.id] = userMeta; saveMeta(metaDb); }
  }

  addEntry(req.user.id, day, { role:"user", message, date:new Date().toISOString() });

  const system = systemPrompt(userMeta.name, userMeta.disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders?.();

  const send = (obj)=> res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = ()=> { res.write("data: [DONE]\n\n"); res.end(); };

  try{
    if(provider==="anthropic" || provider==="claude"){
      if(!process.env.ANTHROPIC_API_KEY){ send({ error:"ANTHROPIC_API_KEY manquante" }); return end(); }

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version":"2023-06-01",
          "content-type":"application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4, stream:true,
          system,
          messages:[{ role:"user", content:user }]
        })
      });

      if(!resp.ok || !resp.body){
        const t = await resp.text().catch(()=> "");
        console.error("Claude stream error:", resp.status, t);
        send({ error:`Claude stream error ${resp.status}: ${t}` }); return end();
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while(true){
        const { done, value } = await reader.read();
        if(done) break;
        const chunk = decoder.decode(value, { stream:true });
        for(const line of chunk.split("\n")){
          if(!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if(payload === "[DONE]") continue;
          try{
            const evt = JSON.parse(payload);
            if(evt.type === "content_block_delta" && evt.delta?.type === "text_delta"){
              const delta = evt.delta.text || "";
              if(delta){ full += delta; send({ text: delta }); }
            }
          }catch{}
        }
      }
      if(full) addEntry(req.user.id, day, { role:"ai", message:full, date:new Date().toISOString() });
      return end();
    }
    send({ error:"Fournisseur inconnu ou non activé" }); end();
  }catch(e){ console.error(e); send({ error:"Erreur serveur" }); end(); }
});

// ---------- ADMIN: stats + users ----------
app.get("/api/admin/stats", auth, adminOnly, (_req,res)=>{
  const users = loadUsers();
  const journal = loadJournal();
  const totalUsers = Object.keys(users).length;
  let totalMsgs = 0;
  for(const uid of Object.keys(journal)){
    const days = journal[uid] || {};
    for(const d of Object.keys(days)){
      const arr = days[d]; if(Array.isArray(arr)) totalMsgs += arr.length;
    }
  }
  res.json({
    totalUsers,
    totalMessages: totalMsgs,
    // mini‑stats J1…J15
    perDay: Array.from({length:15},(_,i)=> i+1).map(d=>{
      let c=0; for(const uid of Object.keys(journal)){ const arr=(journal[uid]||{})[String(d)]; if(Array.isArray(arr)) c+=arr.length; }
      return { day:d, count:c };
    })
  });
});

app.get("/api/admin/users", auth, adminOnly, (_req,res)=>{
  const users = loadUsers();
  const list = Object.values(users).map(u => ({ id:u.id, email:u.email, name:u.name||null, role:u.role, createdAt:u.createdAt }));
  res.json(list);
});

app.post("/api/admin/user/role", auth, adminOnly, (req,res)=>{
  const { userId, role } = req.body || {};
  if(!userId || !role) return res.status(400).json({ error:"userId et role requis" });
  const users = loadUsers();
  if(!users[userId]) return res.status(404).json({ error:"User introuvable" });
  users[userId].role = role;
  saveUsers(users);
  res.json({ success:true });
});

// ---------- Static admin UI ----------
app.get("/admin", (_req,res)=> res.sendFile(path.join(__dirname,"public","admin.html")));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("🚀 CoachBot en ligne sur le port", PORT));
