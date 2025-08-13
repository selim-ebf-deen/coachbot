// Plans (pour affichage uniquement, le serveur a sa propre copie)
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

const daySelect   = document.getElementById('daySelect');
const providerSel = document.getElementById('provider');
const dayPlan     = document.getElementById('dayPlan');
const chatBox     = document.getElementById('chat');
const input       = document.getElementById('input');

// Init jours
for (let i=1;i<=15;i++){ const o=document.createElement('option'); o.value=i; o.textContent=`Jour ${i}`; daySelect.appendChild(o); }
daySelect.value = 1; if (providerSel) providerSel.value = 'anthropic';
dayPlan.textContent = plans[1];

// Helpers
function addMsg(role, text){
  const wrap = document.createElement('div'); wrap.className = `msg ${role}`;
  const dot = document.createElement('span'); dot.className = `dot ${role==='user'?'green':'red'}`;
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
  wrap.appendChild(dot); wrap.appendChild(bubble); chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight; return bubble;
}
async function apiGet(url){ const r=await fetch(url); return r.ok ? r.json() : []; }
async function apiPost(url, body){
  const r=await fetch(url,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return r.json().catch(()=> ({}));
}
function toast(msg){
  const t=document.createElement('div'); t.textContent=msg;
  t.style.cssText=`position:fixed;left:50%;bottom:20px;transform:translateX(-50%);
  background:#0f1823;color:#d7e5f4;border:1px solid #34455e;padding:10px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:9999`;
  document.body.appendChild(t); setTimeout(()=>t.remove(),2000);
}

// Charger l'historique pour le jour courant
async function loadHistoryFor(day){
  const items = await apiGet(`/api/journal?day=${day}`);
  chatBox.innerHTML = "";
  addMsg('ai', "Bienvenue ! Choisis un jour, affiche le plan, puis écris ton message. Si on ne se connaît pas, dis‑moi ton prénom (ex. « je m’appelle Salim »).");
  for (const it of items){
    const role = it.role === 'ai' ? 'ai' : 'user';
    const text = String(it.message||"").replace(/^\[AI\]\s*/,"");
    addMsg(role, text);
  }
}
loadHistoryFor(Number(daySelect.value));

// UI jour
document.getElementById('btnShow').onclick = () => {
  const d = Number(daySelect.value);
  dayPlan.textContent = plans[d] || "";
  loadHistoryFor(d);
};
document.getElementById('btnPrev').onclick = () => {
  const v = Math.max(1, Number(daySelect.value)-1);
  daySelect.value = v; dayPlan.textContent = plans[v] || "";
  loadHistoryFor(v);
};
document.getElementById('btnNext').onclick = () => {
  const v = Math.min(15, Number(daySelect.value)+1);
  daySelect.value = v; dayPlan.textContent = plans[v] || "";
  loadHistoryFor(v);
};
document.getElementById('btnTool').onclick = () => toast("Astuce : note une micro‑action de 10 minutes, faisable aujourd’hui.");
document.getElementById('btnClear').onclick = () => { chatBox.innerHTML = ""; };
document.getElementById('btnExport').onclick = async () => {
  const day = Number(daySelect.value);
  const items = await apiGet(`/api/journal?day=${day}`);
  const text  = items.map(i => `[${i.date}] ${i.role||'user'}: ${i.message}`).join('\n') || 'Journal vide.';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text],{type:'text/plain'})); a.download = `journal_j${day}.txt`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
};

// Streaming SSE helper
async function streamChat({ message, day, provider }, onDelta, onDone, onError){
  try{
    const resp = await fetch('/api/chat/stream', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message, day, provider })
    });
    if (!resp.ok || !resp.body) throw new Error('Stream init error');
    const reader = resp.body.getReader(); const decoder = new TextDecoder();
    while(true){
      const {done, value} = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, {stream:true});
      for (const line of chunk.split('\n')){
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { onDone?.(); return; }
        try{
          const obj = JSON.parse(payload);
          if (obj.error) { onError?.(obj.error); return; }
          if (obj.text) onDelta?.(obj.text);
        }catch{}
      }
    }
    onDone?.();
  }catch(e){ onError?.(e.message || 'Erreur de stream'); }
}

// Envoi
document.getElementById('btnSend').onclick = async () => {
  const txt = input.value.trim(); if(!txt) return;
  const day = Number(daySelect.value);
  const provider = providerSel?.value || 'anthropic';

  addMsg('user', txt);
  input.value = "";

  // journaliser côté serveur (par jour)
  await apiPost('/api/journal/save', { day, message: txt, role: 'user' });

  // réponse en streaming
  const bubble = addMsg('ai', "…");
  let acc = "";

  await streamChat(
    { message: txt, day, provider },
    (delta) => { acc += delta; bubble.textContent = acc; },
    () => { /* fin */ },
    (err) => { bubble.textContent = "Erreur: " + err; }
  );
};

document.getElementById('btnSave').onclick = async () => {
  const txt = input.value.trim(); if(!txt) return toast("Rien à sauvegarder.");
  const day = Number(daySelect.value);
  await apiPost('/api/journal/save', { day, message: txt, role: 'user' });
  input.value = ""; toast("Réponse sauvegardée !");
};
