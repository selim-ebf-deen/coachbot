// main.js — UI app + auth + chat streaming (Enter/Shift+Enter + auto-resize + multi-bulles)

const $ = (sel) => document.querySelector(sel);

// UI elements
const chat = $("#chat");
const daySel = $("#daySel");
const showPlanBtn = $("#showPlan");
const plan = $("#plan");
const msg = $("#msg");
const sendBtn = $("#sendBtn");
const who = $("#who");
const loginBtn = $("#loginBtn");
const logoutBtn = $("#logoutBtn");
const adminBtn = $("#adminBtn");
const providerSel = $("#providerSel");

// Modal auth
const scrim = $("#scrim");
const closeModal = $("#closeModal");
const doLogin = $("#doLogin");
const doRegister = $("#doRegister");
const email = $("#email");
const pass = $("#pass");
const regName = $("#regName");
const toggleEye = $("#toggleEye");
const loginErr = $("#loginErr");
const loginInfo = $("#loginInfo");

// Storage
const TOKEN_KEY = "coachbot.token";
function token(){ return localStorage.getItem(TOKEN_KEY) || null; }
function setToken(t){ if(t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function authHeaders(h={}){ const t = token(); if(t) h.Authorization = "Bearer "+t; return h; }

// Generic API
async function api(path, opt={}){
  const headers = authHeaders({ "Content-Type":"application/json", ...(opt.headers||{}) });
  const r = await fetch(path, { ...opt, headers });
  return r;
}

// ---------- Bubbles helpers ----------
function addBubble(role, text=""){
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "me" : "ai");
  const dot = `<span class="dot ${role==='user'?'me':'ai'}"></span>`;
  div.innerHTML = `${dot}<span class="btxt">${text}</span>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div.querySelector(".btxt");
}

// Découpe un long texte en segments “naturels”
function splitForBubbles(full){
  const clean = (full || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  // D’abord on coupe par doubles sauts de ligne ; sinon on coupe sur points d’arrêt.
  let blocks = clean.split(/\n{2,}/).filter(Boolean);
  if (blocks.length === 1) {
    blocks = clean.split(/(?<=[.!?…])\s+(?=[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ])/g).filter(Boolean);
  }
  // Re-fusionne si certains blocs sont trop courts
  const merged = [];
  let cur = "";
  for (const b of blocks) {
    if ((cur + " " + b).trim().length < 220) {
      cur = (cur ? cur + " " : "") + b;
    } else {
      if (cur) merged.push(cur);
      cur = b;
    }
  }
  if (cur) merged.push(cur);
  return merged;
}

function setLogged(user){
  if(user){
    who.textContent = `Connecté : ${user.name || user.email}`;
    who.classList.add("is-logged");
    logoutBtn.style.display = "";
    loginBtn.style.display = "none";
    adminBtn.style.display = (user.role === "admin") ? "" : "none";
  }else{
    who.textContent = "Non connecté";
    who.classList.remove("is-logged");
    logoutBtn.style.display = "none";
    loginBtn.style.display = "";
    adminBtn.style.display = "none";
  }
}

function showLogin(open=true){
  scrim.style.display = open ? "flex" : "none";
  if(open){ loginErr.textContent=""; loginInfo.style.display="none"; }
}

// ---------- Build day select + plan ----------
for(let d=1; d<=15; d++){
  const o = document.createElement("option");
  o.value = d; o.textContent = "Jour " + d;
  daySel.appendChild(o);
}
daySel.value = "1";
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
function renderPlan(){ plan.textContent = plans[Number(daySel.value)] || ""; }
renderPlan();

// ---------- Auto-resize du textarea ----------
function autoResize(){
  msg.style.height = 'auto';
  const max = parseInt(getComputedStyle(msg).maxHeight || '0', 10) || 9999;
  msg.style.height = Math.min(msg.scrollHeight, max) + 'px';
}
msg.addEventListener('input', autoResize);

// ---------- Envoi au clavier ----------
msg.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ---------- Events UI ----------
showPlanBtn.addEventListener("click", renderPlan);
loginBtn.addEventListener("click", ()=>showLogin(true));
closeModal.addEventListener("click", ()=>showLogin(false));
logoutBtn.addEventListener("click", ()=>{
  setToken(null); 
  setLogged(null); 
  chat.innerHTML=""; 
  addBubble("ai","Déconnecté.");
});
toggleEye.addEventListener("click", ()=>{ pass.type = pass.type === "password" ? "text":"password"; });

// ---------- Auth ----------
doLogin.addEventListener("click", async ()=>{
  loginErr.textContent = "";
  try{
    const r = await fetch("/api/auth/login", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email:email.value, password:pass.value })
    });
    if(!r.ok){ loginErr.textContent="Identifiants invalides."; return; }
    const d = await r.json();
    setToken(d.token); setLogged(d.user);
    loginInfo.style.display="";          // petit OK visuel
    setTimeout(()=> showLogin(false), 500);
    await loadJournal();
  }catch{ loginErr.textContent="Erreur réseau."; }
});

doRegister.addEventListener("click", async ()=>{
  loginErr.textContent = "";
  try{
    const r = await fetch("/api/auth/register", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email:email.value, password:pass.value, name:regName.value })
    });
    if(!r.ok){
      const t = await r.json().catch(()=> ({}));
      loginErr.textContent = t?.error === "email_taken" ? "Email déjà utilisé." : "Erreur d'inscription.";
      return;
    }
    const d = await r.json();
    setToken(d.token); setLogged(d.user);
    loginInfo.style.display="";
    setTimeout(()=> showLogin(false), 500);
    await loadJournal();
  }catch{ loginErr.textContent="Erreur réseau."; }
});

// ---------- Boot : /api/me ----------
(async function boot(){
  try{
    const r = await api("/api/me");
    if (r.ok){
      const d = await r.json();
      setLogged(d.user);
      await loadJournal();
    } else {
      setLogged(null);
    }
  }catch{ setLogged(null); }
})();

// ---------- Journal ----------
async function loadJournal(){
  chat.innerHTML = "";
  addBubble("ai", "Conversation chargée (jour " + daySel.value + ").");
  try{
    const r = await api("/api/journal?day="+daySel.value);
    if(!r.ok){ addBubble("ai","Erreur : impossible de charger le journal."); return; }
    const list = await r.json();
    for (const m of list){
      addBubble(m.role === "user" ? "user" : "ai", m.message);
    }
  }catch{ addBubble("ai","Erreur de chargement."); }
}
daySel.addEventListener("change", loadJournal);

// ---------- Envoi message (bouton + streaming multi-bulles) ----------
sendBtn.addEventListener("click", sendMessage);

async function sendMessage(){
  const text = (msg.value||"").trim();
  if(!text) return;

  addBubble("user", text);
  msg.value = "";
  autoResize();

  try{
    const r = await api("/api/chat/stream", {
      method:"POST",
      body: JSON.stringify({ message:text, day:Number(daySel.value), provider: providerSel?.value || "anthropic" })
    });
    if(!r.ok){ addBubble("ai","Erreur côté IA."); return; }

    // Prépare première bulle IA à alimenter en streaming
    let curTarget = addBubble("ai","");

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";        // on accumule le texte total
    let lastFlush = "";     // stocke le segment déjà flushé dans la bulle en cours

    const flushIfNeeded = ()=>{
      // découpe en blocs ; si on détecte qu’un nouveau bloc est apparu,
      // on “ferme” la bulle courante et on en crée une nouvelle.
      const parts = splitForBubbles(buffer);
      const already = splitForBubbles(lastFlush);
      if (parts.length > already.length) {
        const nextPiece = parts[already.length]; // nouveau bloc
        if (nextPiece !== undefined) {
          // si la bulle courante contient quelque chose, on ouvre une nouvelle
          if (curTarget.textContent.trim().length > 0) {
            curTarget = addBubble("ai","");
          }
          curTarget.textContent = nextPiece;
          lastFlush = parts.slice(0, already.length + 1).join("\n\n");
          chat.scrollTop = chat.scrollHeight;
        }
      } else {
        // même bloc : on remplit juste la bulle courante
        const current = parts[parts.length-1] || buffer;
        curTarget.textContent = current;
        lastFlush = parts.slice(0, parts.length-1).join("\n\n");
      }
    };

    while(true){
      const { done, value } = await reader.read();
      if(done) break;
      const chunk = decoder.decode(value, { stream:true });
      for(const line of chunk.split("\n")){
        if(!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if(payload === "[DONE]") break;
        try{
          const evt = JSON.parse(payload);
          if(evt.text) {
            buffer += evt.text;
            flushIfNeeded();
          }
          if(evt.error){
            curTarget.textContent = "[Erreur] " + evt.error;
          }
        }catch{/* ignore */}
      }
    }
  }catch{
    addBubble("ai","Erreur réseau.");
  }
}
