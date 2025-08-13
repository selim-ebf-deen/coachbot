import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

// ----- App -----
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ----- Paths -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----- Journal (JSON sur disque) -----
const FILE_PATH = process.env.DB_PATH || "/data/journal.json";
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8")); }
  catch { return []; }
}
function saveJournal(entries) {
  try {
    fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
    fs.writeFileSync(FILE_PATH, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.error("Save journal error:", e);
  }
}

// ----- UI statique -----
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ----- Journal API -----
app.post("/api/journal/save", (req, res) => {
  const { message } = req.body || {};
  const entries = loadJournal();
  entries.push({ message, date: new Date().toISOString() });
  saveJournal(entries);
  res.json({ success: true });
});
app.get("/api/journal", (_req, res) => {
  res.json(loadJournal());
});

// ----- Contexte programme -----
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

function systemPrompt() {
  return `Tu es CoachBot, un coach bienveillant et concret.
- Style: clair, respectueux, orienté actions (micro‑étapes, responsabilités, KISS).
- Si l’utilisateur est vague, pose 1 à 2 questions ciblées, puis propose une micro‑action de 10 minutes.
- Réponds en français.`;
}

// ----- /api/chat (non-stream) -----
app.post("/api/chat", async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const plan = plans[Number(day)] || "Plan non spécifié.";
    const userPrompt = `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;

    // Claude (Anthropic)
    if (provider === "anthropic" || provider === "claude") {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante" });
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4,
          system: systemPrompt(),
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: "Claude error", details: data });
      const reply = data?.content?.[0]?.text || "";
      const entries = loadJournal(); entries.push({ message: `[AI] ${reply}`, date: new Date().toISOString() }); saveJournal(entries);
      return res.json({ reply });
    }

    // OpenAI
    if (provider === "openai") {
      if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY manquante" });
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.4,
          messages: [{ role: "system", content: systemPrompt() }, { role: "user", content: userPrompt }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: "OpenAI error", details: data });
      const reply = data.choices?.[0]?.message?.content?.trim() || "";
      const entries = loadJournal(); entries.push({ message: `[AI] ${reply}`, date: new Date().toISOString() }); saveJournal(entries);
      return res.json({ reply });
    }

    // Gemini (bloc unique)
    if (provider === "gemini" || provider === "google") {
      if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY manquante" });
      const model = process.env.GEMINI_MODEL || "gemini-1.5-pro";
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: systemPrompt() + "\n\n" + userPrompt }]}] })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: "Gemini error", details: data });
      const reply = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join("") || "";
      const entries = loadJournal(); entries.push({ message: `[AI] ${reply}`, date: new Date().toISOString() }); saveJournal(entries);
      return res.json({ reply });
    }

    return res.status(400).json({ error: "Fournisseur inconnu" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ----- /api/chat/stream (SSE) -----
app.post("/api/chat/stream", async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};
  const plan = plans[Number(day)] || "Plan non spécifié.";
  const userPrompt = `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;

  // Préparer SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    // Claude (Anthropic) streaming
    if (provider === "anthropic" || provider === "claude") {
      if (!process.env.ANTHROPIC_API_KEY) { send({ error: "ANTHROPIC_API_KEY manquante" }); return end(); }
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022",
          max_tokens: 800, temperature: 0.4, stream: true,
          system: systemPrompt(),
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(()=> ""); send({ error: "Claude stream error", details: t }); return end();
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") break;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              const delta = evt.delta.text || "";
              if (delta) { full += delta; send({ text: delta }); }
            }
          } catch { /* ignore */ }
        }
      }
      if (full) {
        const entries = loadJournal();
        entries.push({ message: `[AI] ${full}`, date: new Date().toISOString() });
        saveJournal(entries);
      }
      return end();
    }

    // OpenAI streaming
    if (provider === "openai") {
      if (!process.env.OPENAI_API_KEY) { send({ error: "OPENAI_API_KEY manquante" }); return end(); }
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.4, stream: true,
          messages: [{ role: "system", content: systemPrompt() }, { role: "user", content: userPrompt }]
        })
      });
      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(()=> ""); send({ error: "OpenAI stream error", details: t }); return end();
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") break;
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content || "";
            if (delta) { full += delta; send({ text: delta }); }
          } catch { /* ignore */ }
        }
      }
      if (full) {
        const entries = loadJournal();
        entries.push({ message: `[AI] ${full}`, date: new Date().toISOString() });
        saveJournal(entries);
      }
      return end();
    }

    // Gemini (pas de stream natif via SSE ici)
    if (provider === "gemini" || provider === "google") {
      if (!process.env.GEMINI_API_KEY) { send({ error: "GEMINI_API_KEY manquante" }); return end(); }
      const model = process.env.GEMINI_MODEL || "gemini-1.5-pro";
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: systemPrompt() + "\n\n" + userPrompt }]}] })
      });
      const data = await resp.json();
      const reply = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join("") || "";
      if (reply) {
        send({ text: reply });
        const entries = loadJournal(); entries.push({ message: `[AI] ${reply}`, date: new Date().toISOString() }); saveJournal(entries);
      } else {
        send({ error: "Gemini empty" });
      }
      return end();
    }

    send({ error: "Fournisseur inconnu" }); return end();
  } catch (e) {
    console.error(e);
    send({ error: "Erreur serveur" }); return end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur sur le port ${PORT}`));
