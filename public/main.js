/* ====== util ====== */
const $ = (id) => document.getElementById(id);
const tokenKey = "coachbot.token";
const plans = {
  1:"Clarification des intentions : précise le défi prioritaire à résoudre en 15 jours, pourquoi c’est important, et ce que ‘réussir’ signifie concrètement.",
  2:"Diagnostic : état des lieux, 3 leviers, 3 obstacles.",
  3:"Vision + 3 indicateurs mesurables.",
  4:"Valeurs et motivations.",
  5:"Énergie : estime de soi / amour propre / confiance.",
  6:"Confiance : preuves, retours, micro‑victoires.",
  7:"Bilan intermédiaire KISS (Keep / Improve / Start / Stop).",
  8:"Nouveau départ : cap et prochaines 48h.",
  9:"Plan simple : 1 action / jour.",
  10:"Message clé (CNV).",
  11:"Décisions : Stop / Keep / Start.",
  12:"Échelle de responsabilité : au‑dessus de la ligne.",
  13:"Co‑développement éclair.",
  14:"Leadership (Maxwell).",
  15:"Bilan final + plan 30 jours."
};

function setPlan(day){ $("plan").textContent = `Jour ${day} — ${plans[day]||""}`; }
function toast(msg){ alert(msg); } // simple & efficace

function authHeader(){
  const t = localStorage.getItem(tokenKey);
  return t ? { Authorization: "Bearer "+t } : {};
}
async function api(path, options={}){
  const r = await fetch(path, {
    ...options,
    headers: {
      "Content-Type":"application/json",
      ...authHeader(),
      ...(options.headers||{})
    }
  });
  return r;
}

/* ====== UI chat ====== */
function renderMsg(role, text){
  const line = document.createElement("div");
  line.className = role === "user" ? "row me" : "row ai";
  const dot = document.createElement("span");
  dot.className = "dot " + (role==="user"?"green":"red");
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  line.appendChild(dot); line.appendChild(b);
  $("chat").appendChild(line);
  $("chat").scrollTop = $("chat").scrollHeight;
}
function clearChat(){ $("chat").innerHTML=""; }

/* ====== auth modal ====== */
const modal = $("authModal");
$("openAuth").onclick = () => openModal();
$("closeAuth").onclick = () => closeModal();
function openModal(){ modal.classList.add("open"); }
function closeModal(){ modal.classList.remove("open"); $("authErr").textContent=""; }

$("togglePwd").onclick = () => {
  const f = $("authPassword");
  f.type = (f.type === "password") ? "text" : "password";
};

let authMode = "user"; // user | admin (visuel uniquement)
$("tabUser").onclick = ()=>{authMode="user"; $("tabUser").classList.add("active"); $("tabAdmin").classList.remove("active");};
$("tabAdmin").onclick = ()=>{authMode="admin"; $("tabAdmin").classList.add("active"); $("tabUser").classList.remove("active");};

/* ====== login/register ====== */
$("loginBtn").onclick = doAuth;
$("registerBtn").onclick = doAuth;

async function doAuth(e){
  const isRegister = (e.target.id === "registerBtn");
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value.trim();
  const name = $("authName").value.trim();
  const url = isRegister ? "/api/auth/register" : "/api/auth/login";
  const payload = isRegister ? { email, password, name } : { email, password };

  $("authErr").textContent = "";
  try{
    const r = await api(url, { method:"POST", body: JSON.stringify(payload) });
    if(!r.ok){
      const text = await r.text().catch(()=> "Erreur.");
      $("authErr").textContent = text || "Erreur.";
      return;
    }
    const data = await r.json();
    localStorage.setItem(tokenKey, data.token);

    toast("✅ Connexion réussie !");
    closeModal();
    await hydrateMe();

    if (data.user?.role === "admin") {
      // petit délai pour laisser l’UI se mettre à jour
      setTimeout(()=> location.href="/admin", 50);
    }
  }catch(err){
    $("authErr").textContent = "Erreur réseau : " + err.message;
  }
}

/* ====== me / logout ====== */
$("logoutBtn").onclick = ()=>{
  localStorage.removeItem(tokenKey);
  $("who").textContent = "Non connecté";
  $("logoutBtn").style.display = "none";
  $("adminBtn").style.display = "none";
  openModal();
};

async function hydrateMe(){
  try{
    const r = await api("/api/me");
    if(r.status === 401){ // non connecté
      $("who").textContent = "Non connecté";
      $("logoutBtn").style.display = "none";
      $("adminBtn").style.display = "none";
      openModal();
      return;
    }
    if(!r.ok) throw new Error("Impossible de charger /api/me");
    const d = await r.json();
    $("who").textContent = d?.user?.name ? `Connecté : ${d.user.name}` : `Connecté : ${d.user?.email||"?"}`;
    $("logoutBtn").style.display = "inline-block";
    $("adminBtn").style.display = (d?.user?.role === "admin") ? "inline-block" : "none";
    $("connState").textContent = `Prénom: ${d.meta?.name || "—"} • DISC: ${d.meta?.disc || "—"}`;
    await loadJournal();
  }catch{ $("connState").textContent = "Erreur chargement profil."; }
}

/* ====== journal ====== */
async function loadJournal(){
  const day = Number($("daySel").value||1);
  setPlan(day);
  clearChat();
  try{
    const r = await api(`/api/journal?day=${day}`);
    if(!r.ok) throw new Error();
    const list = await r.json();
    (list||[]).forEach(m => renderMsg(m.role==="ai"?"ai":"user", m.message));
  }catch{ renderMsg("ai","Erreur : impossible de charger le journal."); }
}
$("daySel").onchange = loadJournal;

/* ====== chat (stream Claude) ====== */
$("sendBtn").onclick = sendMsg;
$("msg").addEventListener("keydown", (e)=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendMsg(); } });

async function sendMsg(){
  const text = $("msg").value.trim();
  if(!text) return;
  $("msg").value = "";
  renderMsg("user", text);

  const body = { message:text, day:Number($("daySel").value||1), provider:$("providerSel").value };
  try{
    const r = await api("/api/chat/stream", { method:"POST", body: JSON.stringify(body) });
    if(!r.ok || !r.body){ renderMsg("ai","Erreur côté IA : stream indisponible."); return; }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let aiBuffer = "";
    let node; // un seul bubble pour l’IA en streaming

    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      const chunk = decoder.decode(value, {stream:true});
      for(const line of chunk.split("\n")){
        if(!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if(payload === "[DONE]") break;
        try{
          const evt = JSON.parse(payload);
          if(evt.text){
            if(!node){
              // créer une bulle IA stream
              const wrap = document.createElement("div");
              wrap.className = "row ai";
              const d = document.createElement("span"); d.className="dot red";
              const b = document.createElement("div"); b.className="bubble"; b.textContent="";
              wrap.appendChild(d); wrap.appendChild(b);
              $("chat").appendChild(wrap); $("chat").scrollTop = $("chat").scrollHeight;
              node = b;
            }
            aiBuffer += evt.text;
            node.textContent = aiBuffer;
            $("chat").scrollTop = $("chat").scrollHeight;
          }
          if(evt.error){
            renderMsg("ai", "Erreur stream : " + evt.error);
          }
        }catch{/* ignore */}
      }
    }
  }catch(err){
    renderMsg("ai", "Erreur réseau : " + err.message);
  }
}

/* ====== init ====== */
(function init(){
  setPlan(Number($("daySel").value||1));
  // ouvrir la modale si pas de token
  if(!localStorage.getItem(tokenKey)) openModal();
  hydrateMe();
})();
