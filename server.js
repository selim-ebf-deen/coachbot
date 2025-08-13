// server.js — CoachBot multi-utilisateur (complet)
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

const app = express();
app.use(cors());
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------- Fichiers / ENV ----------
const USERS_PATH   = process.env.USERS_PATH   || "/data/users.json";   // comptes
const JOURNAL_PATH = process.env.JOURNAL_PATH || "/data/journal.json"; // journal par user
const META_PATH    = process.env.META_PATH    || "/data/meta.json";    // meta par user
const PROMPT_PATH  = process.env.PROMPT_PATH  || path.join(__dirname, "prompt.txt");
const JWT_SECRET   = process.env.JWT_SECRET   || "change_me_long_secret";

// --------- Helpers fichiers ----------
function ensureDir(p){ fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadJSON(p, fallback){
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return fallback; }
}
function saveJSON(p, obj){ ensureDir(p); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// --------- Stores (schémas) ----------
/*
USERS: { byEmail: { email: { id, email, passwordHash, name } }, byId: { id: user } }
JOURNAL: { [userId]: { [day]: [ {role, message, date} ] } }
META: { [userId]: { name, disc } }
*/
function usersLoad(){ return loadJSON(USERS_PATH, { byEmail:{}, byId:{} }); }
function usersSave(db){ saveJSON(USERS_PATH, db); }

function journalLoad(){ return loadJSON(JOURNAL_PATH, {}); }
function journalSave(db){ saveJSON(JOURNAL_PATH, db); }

function metaLoad(){ return loadJSON(META_PATH, {}); }
function metaSave(db){ saveJSON(META_PATH, db); }

// --------- Prompt / Plans ----------
function getPromptText(){
  try { return fs.readFileSync(PROMPT_PATH, "utf-8"); }
  catch { return "Tu es CoachBot. Réponds en français, brièvement et concrètement, en tutoyant."; }
}
const plans = {
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

// --------- DISC / prénom heuristiques ----------
function maybeExtractName(text){
  const t = (text||"").trim();
  let m = t.match(/je m(?:'|e)appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
       || t.match(/moi c['’]est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
       || (t.split(/\s+/).length===1 ? [null,t] : null);
  return m ? m[1].trim().replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g,"") : null;
}
function inferDISC(text){
  const t=(text||"").trim(), ex=(t.match(/!/g)||[]).length;
  const hasCaps=/[A-Z]{3,}/.test(t), hasNums=/\d/.test(t);
  const asks=/(détail|exact|précis|critère|mesurable|plan|checklist)/i.test(t);
  const people=/(écoute|relation|aider|ensemble|émotion|ressenti|bienveillance)/i.test(t);
  const action=/(action|résultat|vite|maintenant|objectif|deadline|priorit)/i.test(t);
  if(action&&(ex>0||hasCaps)) return "D";
  if(ex>1||/cool|idée|créatif|enthous|fun/i.test(t)) return "I";
  if(people||/calme|rassure|routine|habitude/i.test(t)) return "S";
  if(asks||hasNums||t.length>240) return "C";
  return null;
}

// --------- Auth utils ----------
function signToken(user){ return jwt.sign({ uid:user.id, email:user.email }, JWT_SECRET, { expiresIn: "30d" }); }
function authMiddleware(req,res,next){
  const h=req.headers.authorization||"";
  const m=h.match(/^Bearer (.+)$/i);
  if(!m) return res.status(401).json({error:"Auth requise"});
  try{
    const payload=jwt.verify(m[1], JWT_SECRET);
    const udb=usersLoad();
    const user = udb.byId[payload.uid];
    if(!user) return res.status(401).json({error:"Utilisateur inconnu"});
    req.user=user; next();
  }catch(e){ return res.status(401).json({error:"Token invalide"}); }
}

// --------- Static UI ----------
app.use(express.static(path.join(__dirname,"public")));
app.get("/", (_req,res)=> res.sendFile(path.join(__dirname,"public","index.html")));

// --------- Auth endpoints ----------
app.post("/api/auth/register", (req,res)=>{
  const { email, password, name } = req.body||{};
  if(!email||!password) return res.status(400).json({error:"email et password requis"});
  const udb=usersLoad();
  if(udb.byEmail[email]) return res.status(409).json({error:"Email déjà utilisé"});

  const id = "u_"+Math.random().toString(36).slice(2);
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = { id, email, passwordHash, name: (name||"").trim() || null };

  udb.byEmail[email]=user; udb.byId[id]=user; usersSave(udb);

  // init meta
  const mdb=metaLoad(); mdb[id]={ name: user.name, disc: null }; metaSave(mdb);

  const token=signToken(user);
  res.json({ token, user: { id:user.id, email:user.email, name:user.name } });
});

app.post("/api/auth/login", (req,res)=>{
  const { email, password } = req.body||{};
  if(!email||!password) return res.status(400).json({error:"email et password requis"});
  const udb=usersLoad();
  const user=udb.byEmail[email];
  if(!user) return res.status(401).json({error:"Identifiants invalides"});
  if(!bcrypt.compareSync(password, user.passwordHash)) return res.status(401).json({error:"Identifiants invalides"});
  const token=signToken(user);
  res.json({ token, user: { id:user.id, email:user.email, name:user.name } });
});

app.get("/api/me", authMiddleware, (req,res)=>{
  const mdb=metaLoad();
  const meta = mdb[req.user.id] || { name: req.user.name || null, disc: null };
  res.json({ user: { id:req.user.id, email:req.user.email, name:req.user.name||meta.name||null }, meta });
});

// --------- Journal API (protégée) ----------
app.get("/api/journal", authMiddleware, (req,res)=>{
  const day = String(Number(req.query.day||1));
  const jdb = journalLoad();
  const userJ = jdb[req.user.id] || {};
  const val = userJ[day];
  const list = Array.isArray(val) ? val : (val && typeof val==="object" ? [val] : []);
  res.json(list);
});

function addEntry(userId, day, entry){
  const jdb = journalLoad();
  if(!jdb[userId]) jdb[userId]={};
  const key=String(day);
  const cur=jdb[userId][key];
  const arr = Array.isArray(cur) ? cur : (cur && typeof cur==="object" ? [cur] : []);
  arr.push(entry);
  jdb[userId][key]=arr;
  journalSave(jdb);
}
app.post("/api/journal/save", authMiddleware, (req,res)=>{
  const { day=1, message="", role="user" } = req.body||{};
  addEntry(req.user.id, day, { role, message, date:new Date().toISOString() });
  res.json({success:true});
});

// --------- Meta API (protégée) ----------
app.get("/api/meta", authMiddleware, (req,res)=>{
  const mdb=metaLoad(); res.json(mdb[req.user.id] || { name:req.user.name||null, disc:null });
});
app.post("/api/meta", authMiddleware, (req,res)=>{
  const mdb=metaLoad();
  mdb[req.user.id] = mdb[req.user.id] || { name:null, disc:null };
  if(req.body?.name) mdb[req.user.id].name = String(req.body.name).trim();
  if(req.body?.disc) mdb[req.user.id].disc = String(req.body.disc).toUpperCase();
  metaSave(mdb);
  res.json({ success:true, meta:mdb[req.user.id] });
});

// --------- IA helpers / prompts ----------
function systemPrompt(name, disc){
  const base = getPromptText();
  const note = `

[Contexte CoachBot]
Prénom: ${name || "Inconnu"}
DISC: ${disc || "À déduire"}
Rappels: réponses courtes, concrètes, micro‑action 10 min, critère de réussite, tutoiement.`;
  return base + note;
}
function makeUserPrompt(day, message){
  const plan = plans[Number(day)] || "Plan non spécifié.";
  return `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;
}

// --------- Chat (protégé) non-stream & stream ----------
app.post("/api/chat", authMiddleware, async (req,res)=>{
  try{
    const { message, day=1, provider="anthropic" } = req.body ?? {};
    // enrichir meta via heuristiques
    const mdb=metaLoad(); mdb[req.user.id]=mdb[req.user.id]||{name:req.user.name||null,disc:null};
    if(!mdb[req.user.id].name){ const n=maybeExtractName(message); if(n?.length>=2) mdb[req.user.id].name=n; }
    if(!mdb[req.user.id].disc){ const d=inferDISC(message); if(d) mdb[req.user.id].disc=d; }
    metaSave(mdb);

    addEntry(req.user.id, day, { role:"user", message, date:new Date().toISOString() });

    const system = systemPrompt(mdb[req.user.id].name, mdb[req.user.id].disc);
    const user   = makeUserPrompt(day, message);

    if(provider==="anthropic"||provider==="claude"){
      if(!process.env.ANTHROPIC_API_KEY) return res.status(500).json({error:"ANTHROPIC_API_KEY manquante"});
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type":"application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4,
          system, messages:[{role:"user", content:user}]
        })
      });
      const text = await r.text(); let data; try{ data=JSON.parse(text); }catch{ data=null; }
      if(!r.ok){ return res.status(500).json({error:`Claude error ${r.status}`, details:text}); }
      const reply = data?.content?.[0]?.text || "Peux-tu reformuler ?";
      addEntry(req.user.id, day, { role:"ai", message:reply, date:new Date().toISOString() });
      return res.json({ reply });
    }
    res.status(400).json({error:"Fournisseur non pris en charge"});
  }catch(e){ console.error(e); res.status(500).json({error:"Erreur serveur"}); }
});

app.post("/api/chat/stream", authMiddleware, async (req,res)=>{
  const { message, day=1, provider="anthropic" } = req.body ?? {};
  const mdb=metaLoad(); mdb[req.user.id]=mdb[req.user.id]||{name:req.user.name||null,disc:null};
  if(!mdb[req.user.id].name){ const n=maybeExtractName(message); if(n?.length>=2) mdb[req.user.id].name=n; }
  if(!mdb[req.user.id].disc){ const d=inferDISC(message); if(d) mdb[req.user.id].disc=d; }
  metaSave(mdb);

  addEntry(req.user.id, day, { role:"user", message, date:new Date().toISOString() });

  const system = systemPrompt(mdb[req.user.id].name, mdb[req.user.id].disc);
  const user   = makeUserPrompt(day, message);

  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders?.();
  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = ()=>{ res.write("data: [DONE]\n\n"); res.end(); };

  try{
    if(provider==="anthropic"||provider==="claude"){
      if(!process.env.ANTHROPIC_API_KEY){ send({error:"ANTHROPIC_API_KEY manquante"}); return end(); }
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type":"application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4, stream:true,
          system, messages:[{ role:"user", content:user }]
        })
      });
      if(!resp.ok||!resp.body){ const t=await resp.text().catch(()=> ""); send({error:`Claude stream error ${resp.status}: ${t}`}); return end(); }

      const reader=resp.body.getReader(); const decoder=new TextDecoder(); let full="";
      while(true){
        const {done, value}=await reader.read(); if(done) break;
        const chunk=decoder.decode(value,{stream:true});
        for(const line of chunk.split("\n")){
          if(!line.startsWith("data:")) continue;
          const payload=line.slice(5).trim(); if(payload==="[DONE]") continue;
          try{
            const evt=JSON.parse(payload);
            if(evt.type==="content_block_delta" && evt.delta?.type==="text_delta"){
              const d=evt.delta.text||""; if(d){ full+=d; send({text:d}); }
            }
          }catch{}
        }
      }
      if(full) addEntry(req.user.id, day, { role:"ai", message:full, date:new Date().toISOString() });
      return end();
    }
    send({error:"Fournisseur non pris en charge"}); end();
  }catch(e){ console.error(e); send({error:"Erreur serveur"}); end(); }
});

// --------- Health ----------
app.get("/healthz", (_req,res)=> res.json({ ok:true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("🚀 Serveur en ligne sur le port", PORT));
