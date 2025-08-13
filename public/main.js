// main.js — UI app + auth + chat streaming (Enter/Shift+Enter + auto-resize + bulles courtes)

const $ = sel => document.querySelector(sel);

const chat        = $("#chat");
const daySel      = $("#daySel");
const showPlanBtn = $("#showPlan");
const plan        = $("#plan");
const msg         = $("#msg");
const sendBtn     = $("#sendBtn");

const who         = $("#who");
const loginBtn    = $("#loginBtn");
const logoutBtn   = $("#logoutBtn");
const adminBtn    = $("#adminBtn");
const providerSel = $("#providerSel");

const scrim       = $("#scrim");
const closeModal  = $("#closeModal");
const doLogin     = $("#doLogin");
const doRegister  = $("#doRegister");
const email       = $("#email");
const pass        = $("#pass");
const regName     = $("#regName");
const toggleEye   = $("#toggleEye");
const loginErr    = $("#loginErr");
const loginInfo   = $("#loginInfo");

const TOKEN_KEY = "coachbot.token";

function token(){ return localStorage.getItem(TOKEN_KEY) || null; }
function setToken(t){ if(t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function authHeaders(h={}){ const t = token(); if(t) h.Authorization = "Bearer "+t; return h; }

async function api(path, opt={}){
  const headers = authHeaders({ "Content-Type":"application/json", ...(opt.headers||{}) });
  return fetch(path, { ...opt, headers });
}

// ---------- UI helpers ----------
function bubble(role, text){
  const div = document.createElement("div");
  div.className = "bubble " + (role === "user" ? "me" : "ai");
  const dot = `<span class="dot ${role==='user'?'me':'ai'}"></span>`;
  div.innerHTML = dot + (text || "");
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

/* Émet plusieurs bulles à partir d’un texte :
   - coupe aux fins de phrase
   - limite la taille de bulle pour l’effet “conversation”
*/
function emitBubbles(role, text) {
  if (!text) return;
  // On nettoie et on coupe par phrases
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…])\s+/g);

  const MAX_LEN = 180; // longueur max par bulle
  for (let p of parts) {
    if (!p) continue;
    // Si une phrase est trop longue, on “hard-wrap” en plusieurs bulles
    while (p.length > MAX_LEN) {
      const cut = p.lastIndexOf(" ", MAX_LEN) > 60 ? p.lastIndexOf(" ", MAX_LEN) : MAX_LEN;
      bubble(role, p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (p) bubble(role, p);
  }
}

function setLogged(user){
  if(user){
    who.textContent = `Connecté : ${user.name || user.email}`;
    logoutBtn.style.display = "";
    loginBtn.style.display = "none";
    adminBtn.style.display = (user.role === "admin") ? "" : "none";
  }else{
    who.textContent = "Non connecté";
    logoutBtn.style.display = "none";
    loginBtn.style.display = "";
    adminBtn.style.display = "none";
  }
}

function showLogin(open=true){
  scrim.style.display = open ? "flex" : "none";
  if(open){ loginErr.textContent=""; loginInfo.style.display="none"; }
}

// ---------- Plan J1→J15 ----------
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
daySel.addEventListener("change", loadJournal);

loginBtn.addEventListener("click", ()=>showLogin(true));
closeModal.addEventListener("click", ()=>showLogin(false));
logoutBtn.addEventListener("click", ()=>{
  setToken(null);
  setLogged(null);
  chat.innerHTML="";
  bubble("ai","Déconnecté.");
});

toggleEye.addEventListener("click", ()=>{
  pass.type = pass.type === "password" ? "text":"password";
});

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
    loginInfo.style.display="";
    setTimeout(()=> showLogin(false), 600);
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
    setTimeout(()=> showLogin(false), 600);
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

// ---------- Charger le journal du jour ----------
async function loadJournal(){
  chat.innerHTML = "";
  emitBubbles("ai", "Conversation chargée (jour " + daySel.value + ").");
  try{
    const r = await api("/api/journal?day="+daySel.value);
    if(!r.ok){ emitBubbles("ai","Erreur : impossible de charger le journal."); return; }
    const list = await r.json();
    for (const m of list){
      emitBubbles(m.role === "user" ? "user" : "ai", m.message);
    }
  }catch{ emitBubbles("ai","Erreur de chargement."); }
}

// ---------- Envoi message (bouton) ----------
sendBtn.addEventListener("click", sendMessage);

// ---------- Streaming + bulles courtes ----------
async function sendMessage(){
  const text = (msg.value||"").trim();
  if(!text) return;

  emitBubbles("user", text);
  msg.value = "";
  autoResize();

  try{
    const r = await api("/api/chat/stream", {
      method:"POST",
      body: JSON.stringify({ message:text, day:Number(daySel.value), provider: providerSel?.value || "anthropic" })
    });
    if(!r.ok){ emitBubbles("ai","Erreur côté IA."); return; }

    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const flush = (force=false) => {
      // coupe par fins de phrase
      const parts = buffer.split(/(?<=[.!?…])\s+/g);
      // garde la dernière partie (potentiellement incomplète) en tampon
      buffer = parts.pop() || "";
      // émet le reste
      for (const p of parts) {
        const s = (p||"").trim();
        if (s) emitBubbles("ai", s);
      }
      // si force=true, on vide tout
      if (force && buffer.trim()) {
        emitBubbles("ai", buffer.trim());
        buffer = "";
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
            // petit flush sur ponctuation ou quand le buffer devient long
            if (/[.!?…]\s$/.test(buffer) || buffer.length > 220) flush(false);
          }
          if(evt.error){ emitBubbles("ai", "[Erreur] " + evt.error); }
        }catch{ /* ignore */ }
      }
    }
    // fin de flux → on vide ce qui reste
    flush(true);

  }catch{
    emitBubbles("ai","Erreur réseau.");
  }
}
