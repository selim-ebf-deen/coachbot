// --- Données et utilitaires ---
const plans = {
  1: "Jour 1 — Clarification des intentions : précise le défi prioritaire à résoudre en 15 jours, pourquoi c’est important, et ce que ‘réussir’ signifie concrètement.",
  2: "Jour 2 — Diagnostic de la situation actuelle : fais un état des lieux honnête, repère 3 leviers et 3 obstacles.",
  3: "Jour 3 — Vision et critères de réussite : formuler l’issue idéale, définir 3 indicateurs factuels.",
  4: "Jour 4 — Valeurs et motivations : aligne objectifs et valeurs, clarifie les non‑négociables.",
  5: "Jour 5 — Énergie : estime de soi, amour propre, confiance (modèle 3 niveaux).",
  6: "Jour 6 — Confiance (suite) : preuves, retours, micro‑victoires.",
  7: "Jour 7 — Bilan et KISS (Keep‑Improve‑Start‑Stop).",
  8: "Jour 8 — Nouveau départ : cap, intentions, prochaines 48h.",
  9: "Jour 9 — Plan d’action 10x plus simple : 1 chose / jour.",
  10:"Jour 10 — Communication non violente (CNV) : un message clé à préparer.",
  11:"Jour 11 — Décisions : Stop / Keep / Start.",
  12:"Jour 12 — Échelle de responsabilité : remonter au-dessus de la ligne.",
  13:"Jour 13 — Co‑développement éclair (pairing) : alternative mini.",
  14:"Jour 14 — Leadership (Maxwell) : comportements du niveau actuel + un cran au‑dessus.",
  15:"Jour 15 — Bilan final et suite : 30 prochains jours."
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

// --- Raccourcis UI ---
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
  toast("Astuce : pense à noter 1 micro‑action faisable en 10 minutes.");
};
document.getElementById('btnClear').onclick = () => {
  chatBox.innerHTML = "";
};
document.getElementById('btnExport').onclick = async () => {
  const items = await apiGet('/api/journal');
  const text  = items.map(i => `[${i.date}] ${i.message}`).join('\n');
  download('journal.txt', text || 'Journal vide.');
};

// --- API Helpers ---
async function apiGet(url){
  const r = await fetch(url);
  if(!r.ok) return [];
  return r.json();
}
async function apiPost(url, body){
  const r = await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  return r.json().catch(()=> ({}));
}

// --- Chat rendering ---
function addMsg(role, text){
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const ava = document.createElement('div'); ava.className = 'avatar'; ava.textContent = role==='user'?'🙂':'🤖';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
  wrap.appendChild(ava); wrap.appendChild(bubble);
  chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function loadHistory(){
  const items = await apiGet('/api/journal');
  chatBox.innerHTML = "";
  // On affiche en bulles “bot” pour la 1re ligne de bienvenue + contenu historique
  addMsg('bot', "Bienvenue ! Sélectionnez un jour, puis posez votre question ou décrivez votre situation.");
  for(const it of items){
    if(!it?.message) continue;
    addMsg('user', it.message);
  }
}
loadHistory();

// --- Actions ---
document.getElementById('btnSend').onclick = async () => {
  const txt = input.value.trim();
  if(!txt) return;
  addMsg('user', txt);
  input.value = "";
  // Sauvegarde côté serveur (journal)
  await apiPost('/api/journal/save', { message: txt });
  // Réponse simulée (sans IA pour l’instant)
  addMsg('bot', "Reçu. Qu’est‑ce qui ferait que ce soit un bon résultat d’ici 15 jours ?");
};

document.getElementById('btnSave').onclick = async () => {
  const txt = input.value.trim();
  if(!txt) return toast("Rien à sauvegarder.");
  await apiPost('/api/journal/save', { message: txt });
  input.value = "";
  toast("Réponse sauvegardée !");
};

// --- Petits utilitaires ---
function download(filename, text){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text],{type:'text/plain'}));
  a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
function toast(msg){
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `
    position:fixed;left:50%;bottom:20px;transform:translateX(-50%);
    background:#0f1823;color:#d7e5f4;border:1px solid #34455e;
    padding:10px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:9999
  `;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 2000);
}
