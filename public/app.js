/* app.js — UI avancée (Tailwind) pour CoachBot */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// --- éléments
const daySelect   = $("#daySelect");
const prevDayBtn  = $("#prevDay");
const nextDayBtn  = $("#nextDay");
const showPlanBtn = $("#showPlan");
const toolsBtn    = $("#toolsBtn");
const toolsMenu   = $("#toolsMenu");

const dayPlanEl   = $("#dayPlan");
const chatEl      = $("#chat");
const formEl      = $("#form");
const inputEl     = $("#input");
const providerEl  = $("#provider");
const sendBtn     = $("#sendBtn");
const saveNoteBtn = $("#saveNoteBtn");
const exportBtn   = $("#exportBtn");
const clearBtn    = $("#clearBtn");

// --- plans des jours (doit refléter le serveur)
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

// --- état
let state = {
  day: Number(localStorage.getItem("day")) || 1,
  provider: localStorage.getItem("provider") || "anthropic",
};

// --- helpers UI
function option(v, label) {
  const o = document.createElement("option");
  o.value = v; o.textContent = label;
  return o;
}
function setPlan(day) {
  dayPlanEl.textContent = plans[day] || "Plan non spécifié.";
}
function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}
function dot(color) {
  return `<span class="inline-block w-2 h-2 rounded-full ${color} mt-2"></span>`;
}
function bubble(role, text) {
  // user => vert, coach => rouge
  const isUser = role === "user";
  const color = isUser ? "bg-green-400" : "bg-rose-500";
  const align = isUser ? "items-start" : "items-start"; // mêmes cartes, on distingue par dot/couleur
  const bg    = isUser ? "bg-slate-800/80" : "bg-slate-800/80";
  return `
    <div class="flex ${align} gap-3">
      ${dot(color)}
      <div class="max-w-[80%] px-3.5 py-2.5 rounded-xl ${bg} ring-1 ring-white/5 leading-relaxed text-slate-200 whitespace-pre-wrap">
        ${text}
      </div>
    </div>
  `;
}
function sys(text) {
  return `
    <div class="flex items-start gap-3">
      ${dot("bg-blue-400")}
      <div class="max-w-[80%] px-3.5 py-2.5 rounded-xl bg-slate-900/60 ring-1 ring-white/5 text-slate-300 text-sm">
        ${text}
      </div>
    </div>
  `;
}

// --- menu outils
toolsBtn.addEventListener("click", () => {
  toolsMenu.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!toolsBtn.contains(e.target) && !toolsMenu.contains(e.target)) {
    toolsMenu.classList.add("hidden");
  }
});
toolsMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tool]");
  if (!btn) return;
  const tool = btn.dataset.tool;
  toolsMenu.classList.add("hidden");

  let insert = "";
  if (tool === "kiss") {
    insert = "KISS —\nKeep: \nImprove: \nStart: \nStop: ";
  } else if (tool === "responsibility") {
    insert = "Échelle de responsabilité —\nAu-dessous: blâme, excuses, déni\nAu-dessus: prise de conscience, responsabilité, action\nOù te situes-tu maintenant ?";
  } else if (tool === "cnv") {
    insert = "CNV —\nQuand je vois/entends…\nJe me sens… car j’ai besoin de…\nJe te demande de…";
  }
  inputEl.value = insert;
  inputEl.focus();
});

// --- jour
for (let d = 1; d <= 15; d++) {
  daySelect.appendChild(option(String(d), `Jour ${d}`));
}
daySelect.value = String(state.day);
setPlan(state.day);

daySelect.addEventListener("change", () => {
  state.day = Number(daySelect.value);
  localStorage.setItem("day", String(state.day));
  setPlan(state.day);
  loadJournal();
});
prevDayBtn.addEventListener("click", () => {
  if (state.day > 1) { state.day--; daySelect.value = String(state.day); daySelect.dispatchEvent(new Event("change")); }
});
nextDayBtn.addEventListener("click", () => {
  if (state.day < 15) { state.day++; daySelect.value = String(state.day); daySelect.dispatchEvent(new Event("change")); }
});
showPlanBtn.addEventListener("click", () => {
  chatEl.insertAdjacentHTML("beforeend", sys(`<strong>Plan du jour</strong> — ${plans[state.day]}`));
  scrollBottom();
});

// --- provider
providerEl.value = state.provider;
providerEl.addEventListener("change", () => {
  state.provider = providerEl.value;
  localStorage.setItem("provider", state.provider);
});

// --- journal
async function loadJournal() {
  chatEl.innerHTML = "";
  // petit message d’accueil
  chatEl.insertAdjacentHTML("beforeend", sys(`Bienvenue ! Choisis un jour, affiche le plan, puis écris ton message. Si on ne se connaît pas, dis-moi ton prénom (ex. « je m’appelle Salim »).`));
  scrollBottom();

  try {
    const r = await fetch(`/api/journal?day=${state.day}`);
    const data = await r.json();
    for (const item of data) {
      chatEl.insertAdjacentHTML("beforeend", bubble(item.role, escapeHTML(item.message)));
    }
    scrollBottom();
  } catch (e) {
    chatEl.insertAdjacentHTML("beforeend", sys(`Erreur: impossible de charger le journal.`));
  }
}
loadJournal();

// --- envoyer message (streaming)
formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = (inputEl.value || "").trim();
  if (!message) return;

  // afficher le message utilisateur
  chatEl.insertAdjacentHTML("beforeend", bubble("user", escapeHTML(message)));
  scrollBottom();
  inputEl.value = "";

  // container pour la réponse en streaming
  const aiContainer = document.createElement("div");
  aiContainer.innerHTML = bubble("ai", "");
  chatEl.appendChild(aiContainer);
  const aiBubble = aiContainer.querySelector(".max-w-[80%]");
  let full = "";

  try {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, day: state.day, provider: state.provider })
    });

    if (!resp.ok || !resp.body) {
      const errTxt = await safeText(resp);
      aiBubble.textContent = `Erreur côté IA : ${errTxt || "Stream indisponible"}`;
      scrollBottom();
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      // on lit les lignes SSE "data: {...}"
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.error) {
            aiBubble.textContent = `Erreur: ${evt.error}`;
          } else if (evt.text) {
            full += evt.text;
            aiBubble.textContent = full;
            scrollBottom();
          }
        } catch { /* ignore */ }
      }
    }

  } catch (e2) {
    aiBubble.textContent = `Erreur réseau: ${e2?.message || e2}`;
  } finally {
    scrollBottom();
  }
});

// --- sauvegarder une note manuelle dans le journal
saveNoteBtn.addEventListener("click", async () => {
  const txt = (inputEl.value || "").trim();
  if (!txt) return;
  try {
    await fetch("/api/journal/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day: state.day, message: txt, role: "user" })
    });
    chatEl.insertAdjacentHTML("beforeend", bubble("user", escapeHTML(txt)));
    inputEl.value = "";
    scrollBottom();
  } catch {
    chatEl.insertAdjacentHTML("beforeend", sys("Erreur: sauvegarde impossible."));
  }
});

// --- exporter le journal en .txt
exportBtn.addEventListener("click", async () => {
  try {
    const r = await fetch(`/api/journal?day=${state.day}`);
    const data = await r.json();
    const lines = data.map(m => `[${m.role}] ${m.message}`).join("\n\n");
    const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `journal_jour_${state.day}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    chatEl.insertAdjacentHTML("beforeend", sys("Erreur: export impossible."));
  }
});

// --- effacer l’écran (UI seulement)
clearBtn.addEventListener("click", () => {
  chatEl.innerHTML = "";
  chatEl.insertAdjacentHTML("beforeend", sys("Écran effacé (le journal côté serveur reste intact)."));
});

// --- utilitaires
function escapeHTML(s) {
  return s.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
async function safeText(resp) {
  try { return await resp.text(); } catch { return ""; }
}
