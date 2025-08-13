import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Persistance JSON (Render disk) ----
const FILE_PATH = process.env.DB_PATH || "/data/journal.json";
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8")); }
  catch { return []; }
}
function saveJournal(entries) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(entries, null, 2));
}

// ---- UI statique ----
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Journal API ----
app.post("/api/journal/save", (req, res) => {
  const { message } = req.body;
  const entries = loadJournal();
  entries.push({ message, date: new Date().toISOString() });
  saveJournal(entries);
  res.json({ success: true });
});
app.get("/api/journal", (_req, res) => {
  res.json(loadJournal());
});

// ---- Plans (contexte coaching) ----
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

// ---- Chat IA (OpenAI) ----
app.post("/api/chat", async (req, res) => {
  try {
    const { message, day } = req.body ?? {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY manquante" });
    }
    const plan = plans[Number(day)] || "Plan non spécifié.";
    const system = `Tu es CoachBot, un coach bienveillant et concret. 
- Style: clair, respectueux, orienté actions (micro‑étapes, responsabilités, KISS).
- Contexte du programme 15 jours fourni ci-dessous. 
- Si l’utilisateur est vague, pose 1 ou 2 questions ciblées puis propose une micro‑action de 10 minutes.
- Réponse en français.`;

    // Appel simple Chat Completions
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}` }
        ]
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({ error: "Appel OpenAI en échec", details: data });
    }
    const ai = data.choices?.[0]?.message?.content?.trim() || "Désolé, pas de réponse.";
    // Optionnel: journaliser aussi la réponse
    const entries = loadJournal(); 
    entries.push({ message: `[AI] ${ai}`, date: new Date().toISOString() });
    saveJournal(entries);

    res.json({ reply: ai });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur sur le port ${PORT}`));
