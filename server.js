// server.js — CoachBot (stable baseline)

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

// ---------------- App ----------------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------------- Paths & ENV ----------------
const USERS_PATH   = process.env.USERS_PATH   || "/data/users.json";
const JOURNAL_PATH = process.env.JOURNAL_PATH || "/data/journal.json";
const META_PATH    = process.env.META_PATH    || "/data/meta.json";
const PROMPT_PATH  = process.env.PROMPT_PATH  || path.join(__dirname, "prompt.txt");

const JWT_SECRET   = process.env.JWT_SECRET || "";
const CLAUDE_KEY   = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
if (!JWT_SECRET) console.warn("⚠ JWT_SECRET manquant (Render > Environment).");

// ---------------- FS utils ----------------
function ensureDir(p){ fs.mkdirSync(path.dirname(p), { recursive: true }); }
function loadJSON(p,fallback){ try{ return JSON.parse(fs.readFileSync(p,"utf-8")); } catch{ return fallback; } }
function saveJSON(p,obj){ ensureDir(p); fs.writeFileSync(p, JSON.stringify(obj,null,2)); }

function loadUsers(){ return loadJSON(USERS_PATH, {}); }
function saveUsers(db){ saveJSON(USERS_PATH, db); }
function loadJournal(){ return loadJSON(JOURNAL_PATH, {}); }
function saveJournal(db){ saveJSON(JOURNAL_PATH, db); }
function loadMeta(){ return loadJSON(META_PATH, {}); }
function saveMeta(db){ saveJSON(META_PATH, db); }
function getPrompt(){ try{ return fs.readFileSync(PROMPT_PATH,"utf-8"); } catch{ return "Tu es CoachBot (FR). Réponses brèves, concrètes, tutoiement."; } }

function uid(prefix="u"){ return `${prefix}_${Math.random().toString(36).slice(2,10)}`; }

// ---------------- Plans ----------------
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

// ---------------- Heuristiques prénom/DISC ----------------
function maybeExtractName(text){
  const t=(text||"").trim();
  let m=t.match(/je m(?:'|e)appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
     || t.match(/moi c['’]est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i)
     || (t.split(/\s+/).length===1?[null,t]:null);
  return m ? m[1].trim().replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g,"") : null;
}
function inferDISC(text){
  const t=(text||"").trim(), len=t.length;
  const ex=(t.match(/!/g)||[]).length, hasCaps=/[A-Z]{3,}/.test(t), hasNums=/\d/.test(t);
  const asks=/(détail|exact|précis|critère|mesurable|plan|checklist)/i.test(t);
  const cares=/(écoute|relation|aider|ensemble|émotion|ressenti|bienveillance)/i.test(t);
  const action=/(action|résultat|vite|maintenant|objectif|deadline|priorit)/i.test(t);
  if(action&&(ex>0||hasCaps)) return "D";
  if(ex>1||/cool|idée|créatif|enthous|fun/i.test(t)) return "I";
  if(cares||/calme|rassure|routine|habitude/i.test(t)) return "S";
  if(asks||hasNums||len>240) return "C";
  return null;
}

// ---------------- Prompt compose ----------------
function systemPrompt(name,disc){
  const base=getPrompt();
  const note=`\n\n[Contexte CoachBot]\nPrénom: ${name||"Inconnu"}\nDISC: ${disc||"À déduire"}\nRappels: réponses courtes, concrètes, micro‑action 10 min, critère de réussite, tutoiement, formules islamiques avec mesure, réponses en petites bulles.`;
  return base+note;
}
function userPrompt(day,message){
  const plan=plans[Number(day)]||"Plan non spécifié.";
  return `Plan du jour (J${day}) : ${plan}\n\nMessage utilisateur : ${message}\n\nConsigne: réponds en plusieurs petites bulles, pas de long paragraphe.`;
}

// ---------------- Static ----------------
app.use(express.static(path.join(__dirname,"public")));
app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/admin", (_req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("/healthz", (_req,res)=>res.json({ok:true, ts:Date.now()}));

// ---------------- Auth ----------------
function signToken(user){ return jwt.sign({ sub:user.id, role:user.role }, JWT_SECRET, { expiresIn:"30d" }); }
function auth(req,res,next){
  try{
    const h=req.headers.authorization||"";
    if(!h.startsWith("Bearer ")) return res.status(401).json({error:"unauthorized"});
    const token=h.slice(7);
    const payload=jwt.verify(token, JWT_SECRET);
    const users=loadUsers(); const u=users[payload.sub];
    if(!u) return res.status(401).json({error:"unauthorized"});
    req.user=u; next();
  }catch{ return res.status(401).json({error:"unauthorized"}); }
}
function adminOnly(req,res,next){ if(!req.user||req.user.role!=="admin") return res.status(403).json({error:"forbidden"}); next(); }

app.post("/api/auth/register",(req,res)=>{
  const { email, password, name }=req.body||{};
  if(!email||!password) return res.status(400).json({error:"missing_fields"});
  const users=loadUsers();
  const exists=Object.values(users).find(u=>u.email.toLowerCase()===String(email).toLowerCase());
  if(exists) return res.status(409).json({error:"email_taken"});
  const id=uid("u");
  users[id]={ id, email:String(email).trim(), name:(name||"").trim()||null, role:"user",
    passHash:bcrypt.hashSync(String(password),10), createdAt:new Date().toISOString() };
  saveUsers(users);
  const meta=loadMeta(); meta[id]={ name:users[id].name, disc:null }; saveMeta(meta);
  res.json({ token:signToken(users[id]), user:{ id, email:users[id].email, name:users[id].name, role:"user" }});
});

app.post("/api/auth/login",(req,res)=>{
  const { email, password }=req.body||{};
  if(!email||!password) return res.status(400).json({error:"missing_fields"});
  const users=loadUsers();
  const u=Object.values(users).find(x=>x.email.toLowerCase()===String(email).toLowerCase());
  if(!u) return res.status(401).json({error:"invalid_credentials"});
  if(!bcrypt.compareSync(String(password), u.passHash)) return res.status(401).json({error:"invalid_credentials"});
  res.json({ token:signToken(u), user:{ id:u.id, email:u.email, name:u.name, role:u.role }});
});

app.get("/api/me", auth, (req,res)=>{
  const meta=loadMeta()[req.user.id]||{ name:req.user.name, disc:null };
  res.json({ user:{ id:req.user.id, email:req.user.email, name:req.user.name, role:req.user.role }, meta });
});

// ---------------- Meta ----------------
app.get("/api/meta", auth, (req,res)=>{
  res.json(loadMeta()[req.user.id]||{ name:req.user.name, disc:null });
});
app.post("/api/meta", auth, (req,res)=>{
  const meta=loadMeta(); const curr=meta[req.user.id]||{ name:req.user.name||null, disc:null };
  if(req.body?.name) curr.name=String(req.body.name).trim();
  if(req.body?.disc) curr.disc=String(req.body.disc).toUpperCase();
  meta[req.user.id]=curr; saveMeta(meta);
  res.json({ success:true, meta:curr });
});

// ---------------- Journal (par user & jour) ----------------
function getEntries(userId,day){
  const db=loadJournal(); const u=db[userId]||{}; const arr=u[String(day)];
  return Array.isArray(arr)?arr:[];
}
function addEntry(userId,day,entry){
  const db=loadJournal(); if(!db[userId]) db[userId]={};
  const k=String(day); if(!Array.isArray(db[userId][k])) db[userId][k]=[];
  db[userId][k].push(entry); saveJournal(db);
}

app.get("/api/journal", auth, (req,res)=>{
  const day=Number(req.query.day||1); res.json(getEntries(req.user.id,day));
});
app.post("/api/journal/save", auth, (req,res)=>{
  const { day=1, message="", role="user" }=req.body||{};
  addEntry(req.user.id,day,{ role, message, date:new Date().toISOString() });
  res.json({ success:true });
});

// ---------------- Chat (Claude) ----------------
app.post("/api/chat/stream", auth, async (req,res)=>{
  const { message, day=1, provider="anthropic" }=req.body||{};
  const metaAll=loadMeta(); const my=metaAll[req.user.id]||{ name:req.user.name, disc:null };
  if(!my.name){ const n=maybeExtractName(message); if(n&&n.length>=2){ my.name=n; metaAll[req.user.id]=my; saveMeta(metaAll); } }
  if(!my.disc){ const d=inferDISC(message); if(d){ my.disc=d; metaAll[req.user.id]=my; saveMeta(metaAll); } }

  addEntry(req.user.id,day,{ role:"user", message, date:new Date().toISOString() });

  const system=systemPrompt(my.name,my.disc);
  const user  =userPrompt(day,message);

  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders?.();

  const send=(o)=>res.write(`data: ${JSON.stringify(o)}\n\n`);
  const end =()=>{ res.write("data: [DONE]\n\n"); res.end(); };

  try{
    if((provider==="anthropic"||provider==="claude") && CLAUDE_KEY){
      const r=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{
          "x-api-key":CLAUDE_KEY,
          "anthropic-version":"2023-06-01",
          "content-type":"application/json"
        },
        body:JSON.stringify({
          model:CLAUDE_MODEL, max_tokens:800, temperature:0.4, stream:true,
          system, messages:[{ role:"user", content:user }]
        })
      });
      if(!r.ok||!r.body){ const t=await r.text().catch(()=> ""); send({error:`Claude ${r.status}: ${t}`}); return end(); }

      const reader=r.body.getReader(); const decoder=new TextDecoder(); let full="";
      while(true){
        const {done,value}=await reader.read(); if(done) break;
        const chunk=decoder.decode(value,{stream:true});
        for(const line of chunk.split("\n")){
          if(!line.startsWith("data:")) continue;
          const payload=line.slice(5).trim(); if(payload==="[DONE]") break;
          try{
            const evt=JSON.parse(payload);
            if(evt.type==="content_block_delta" && evt.delta?.type==="text_delta"){
              const delta=evt.delta.text||""; if(delta){ full+=delta; send({ text:delta }); }
            }
          }catch{}
        }
      }
      if(full) addEntry(req.user.id,day,{ role:"ai", message:full, date:new Date().toISOString() });
      return end();
    }
    send({error:"provider_not_supported_or_missing_key"}); return end();
  }catch(e){
    console.error(e); send({error:"server_error"}); return end();
  }
});

// ---------------- Admin ----------------
app.get("/api/admin/users", auth, adminOnly, (_req,res)=>{
  const users=Object.values(loadUsers()).map(u=>({ id:u.id,email:u.email,name:u.name||null,role:u.role,createdAt:u.createdAt }));
  res.json(users);
});
app.post("/api/admin/user/role", auth, adminOnly, (req,res)=>{
  const { userId, role }=req.body||{}; if(!userId||!role) return res.status(400).json({error:"missing_fields"});
  const users=loadUsers(); if(!users[userId]) return res.status(404).json({error:"not_found"});
  users[userId].role=(role==="admin")?"admin":"user"; saveUsers(users); res.json({success:true});
});
app.get("/api/admin/stats", auth, adminOnly, (_req,res)=>{
  const j=loadJournal(); let totalMessages=0; const perDay=[];
  for(let d=1; d<=15; d++){ let c=0; for(const uid of Object.keys(j)){ const arr=j[uid]?.[String(d)]; if(Array.isArray(arr)) c+=arr.length; } perDay.push({day:d,count:c}); totalMessages+=c; }
  const totalUsers=Object.keys(loadUsers()).length; res.json({ totalUsers, totalMessages, perDay });
});

// ---------------- Start ----------------
const PORT=process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`🚀 Serveur en ligne sur le port ${PORT}`));
