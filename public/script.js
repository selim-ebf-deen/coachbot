// --- Plans (doit matcher le serveur pour l’UX) ---
const plans = {
  1: "Jour 1 — Clarification des intentions : précise le défi prioritaire à résoudre en 15 jours, pourquoi c’est important, et ce que ‘réussir’ signifie concrètement.",
  2: "Jour 2 — Diagnostic de la situation actuelle : état des lieux, 3 leviers, 3 obstacles.",
  3: "Jour 3 — Vision et critères de réussite : issue idéale + 3 indicateurs.",
  4: "Jour 4 — Valeurs et motivations : aligne objectifs et valeurs.",
  5: "Jour 5 — Énergie : estime de soi / amour propre / confiance.",
  6: "Jour 6 — Confiance (suite) : preuves, retours, micro‑victoires.",
  7: "Jour 7 — Bilan et KISS (Keep‑Improve‑Start‑Stop).",
  8: "Jour 8 — Nouveau départ : cap et prochaines 48h.",
  9: "Jour 9 — Plan d’action simple : 1 chose / jour.",
  10:"Jour 10 — CNV : préparer un message clé.",
  11:"Jour 11 — Décisions : Stop / Keep / Start.",
  12:"Jour 12 — Échelle de responsabilité : au‑dessus de la ligne.",
  13:"Jour 13 — Co‑développement éclair (pairing).",
  14:"Jour 14 — Leadership (Maxwell).",
  15:"Jour 15 — Bilan final + plan 30 jours."
};

const daySelect = document.getElementById('daySelect');
const dayPlan   = document.getElementById('dayPlan');
const chatBox   = document.getElementById('chat');
const input     = document.getElementById('input');

for (let i=1;i<=15;i++){
  const opt = document.createElement('option');
  opt.value = i; opt.textContent = `Jour ${i}`;
  daySelect.appendChild(opt);
}
daySelect.value = 1;
dayPlan.textContent = plans[1];

// Helpers
function addMsg(role, text){
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const ava = document.createElement('div'); ava.className = 'avatar'; ava.textContent = role==='user'?'🙂':'🤖';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
  wrap.appendChild(ava); wrap.appendChild(bubble);
  chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function apiGet(url){
  const r = await fetch(url);
  return r.ok ? r.json() : [];
}

async function apiPost(url, body){
  const r = await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  return r.json().catch(()=> ({}));
}

function toast(msg){
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `position:fixed;left:50%;bottom:20px;transform:translateX(-50%);
    background:#0f1823;color:#d7e5f4;border:1px solid #34455e;
    padding:10px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:9999`;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2000);
}

// Charger l’historique (journal)
async function loadHistory(){
  const items = await apiGet('/api/journal');
  chatBox.innerHTML = "";
  addMsg('bot', "Bienvenue ! Sélectionnez un jour, puis écrivez votre message.");
  for(const it of items){
    if(!it?.message) continue;
    const role = it.message.startsWith("[AI] ") ? 'bot' : 'user';
    addMsg(role, it.message.replace(/^\[AI\]\s*/, ""));
  }
}
loadHistory();

// UI “Jour”
document.getElementById('btnShow').onclick = () => {
  const d = Number(daySelect.value);
  dayPlan.textContent = plans[d] || "";
};
document.getElementById('btnPrev').onclick = () => {
  const v = Math.max(1, Number(daySelect.value)-1);
  daySelect.value = v; dayPlan.textContent = plans[v] || "";
};
document.getElementById('btnNext').onclick = () => {
  const v = Math.min(15, Number(daySelect.value)+1);
  daySelect.value = v; dayPlan.textContent = plans[v] || "";
};
document.getElementById('btnTool').onclick = () => {
  toast("Astuce : note 1 micro‑action faisable en 10 minutes.");
};
document.getElementById('btnClear').onclick = () => {
  chatBox.innerHTML = "";
};
document.getElementById('btnExport').onclick = async () => {
  const items = await apiGet('/api/journal');
  const text  = items.map(i => `[${i.date}] ${i.message}`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text],{type:'text/plain'}));
  a.download = 'journal.txt';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
};

// Envoi
document.getElementById('btnSend').onclick = async () => {
  const txt = input.value.trim();
  if(!txt) return;
  const day = Number(daySelect.value);
  addMsg('user', txt);
  input.value = "";

  // 1) journaliser côté serveur
  await apiPost('/api/journal/save', { message: txt });

  // 2) appel IA
  const loader = document.createElement('div');
  loader.className = 'msg bot';
  loader.innerHTML = `<div class="avatar">🤖</div><div class="bubble">…</div>`;
  chatBox.appendChild(loader); chatBox.scrollTop = chatBox.scrollHeight;

  try {
    const { reply, error } = await apiPost('/api/chat', { message: txt, day });
    loader.remove();
    if (error) return addMsg('bot', "Erreur côté IA : " + (error.details?.error?.message || error));
    addMsg('bot', reply || "Je n’ai pas pu générer de réponse.");
  } catch (e) {
    loader.remove();
    addMsg('bot', "Erreur lors de l’appel au coach.");
  }
};

document.getElementById('btnSave').onclick = async () => {
  const txt = input.value.trim();
  if(!txt) return toast("Rien à sauvegarder.");
  await apiPost('/api/journal/save', { message: txt });
  input.value = "";
  toast("Réponse sauvegardée !");
};
