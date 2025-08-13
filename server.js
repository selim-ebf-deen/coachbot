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

// ---------- Prompt (fichier séparé) ----------
const PROMPT_PATH = process.env.PROMPT_PATH || path.join(__dirname, "prompt.txt");
const DEFAULT_PROMPT = `Tu es CoachBot. Réponds en français, de manière brève et orientée actions.`;
function getSystemPrompt() {
  try {
    return fs.readFileSync(PROMPT_PATH, "utf-8");
  } catch {
    return DEFAULT_PROMPT;
  }
}

// ---------- Journal PAR JOUR ----------
const FILE_PATH = process.env.DB_PATH || "/data/journal.json";
// Structure: { "1":[{role:"user|ai",message,date}], "2":[...], ... }
function loadDB() {
  try { return JSON.parse(fs.readFileSync(FILE_PATH, "utf-8")); }
  catch { return {}; }
}
function saveDB(db) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(db, null, 2));
}
function getEntries(day) {
  const db = loadDB();
  return db[String(day)] || [];
}
function addEntry(day, entry) {
  const db = loadDB();
  const key = String(day);
  if (!db[key]) db[key] = [];
  db[key].push(entry);
  saveDB(db);
}

// ---------- UI statique ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Plans ----------
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

// ---------- Journal API ----------
app.get("/api/journal", (req, res) => {
  const day = Number(req.query.day || 1);
  res.json(getEntries(day));
});
app.post("/api/journal/save", (req, res) => {
  const { day = 1, message = "", role = "user" } = req.body || {};
  addEntry(day, { role, message, date: new Date().toISOString() });
  res.json({ success: true });
});

// ---------- Chat API (non stream) ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, day = 1, provider = "anthropic" } = req.body ?? {};
    const plan = plans[Number(day)] || "Plan non spécifié.";
    const system = getSystemPrompt();
    const userPrompt = `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;

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
          system,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: "Claude error", details: data });
      const reply = data?.content?.[0]?.text || "";
      addEntry(day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    if (provider === "openai") {
      if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY manquante" });
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.4,
          messages: [{ role: "system", content: system }, { role: "user", content: userPrompt }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: "OpenAI error", details: data });
      const reply = data.choices?.[0]?.message?.content?.trim() || "";
      addEntry(day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    if (provider === "gemini" || provider === "google") {
      if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY manquante" });
      const model = process.env.GEMINI_MODEL || "gemini-1.5-pro";
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: system + "\n\n" + userPrompt }]}] })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(500).json({ error: "Gemini error", details: data });
      const reply = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join("") || "";
      addEntry(day, { role: "ai", message: reply, date: new Date().toISOString() });
      return res.json({ reply });
    }

    return res.status(400).json({ error: "Fournisseur inconnu" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ---------- Chat API (STREAM SSE) ----------
app.post("/api/chat/stream", async (req, res) => {
  const { message, day = 1, provider = "anthropic" } = req.body ?? {};
  const plan = plans[Number(day)] || "Plan non spécifié.";
  const system = getSystemPrompt();
  const userPrompt = `Plan du jour (${day}) : ${plan}\n\nMessage de l'utilisateur : ${message}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end  = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
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
          system,
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
          } catch {}
        }
      }
      if (full) addEntry(day, { role: "ai", message: full, date: new Date().toISOString() });
      return end();
    }

    if (provider === "openai") {
      if (!process.env.OPENAI_API_KEY) { send({ error: "OPENAI_API_KEY manquante" }); return end(); }
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0.4, stream: true,
          messages: [{ role: "system", content: system }, { role: "user", content: userPrompt }]
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
          } catch {}
        }
      }
      if (full) addEntry(day, { role: "ai", message: full, date: new Date().toISOString() });
      return end();
    }

    if (provider === "gemini" || provider === "google") {
      if (!process.env.GEMINI_API_KEY) { send({ error: "GEMINI_API_KEY manquante" }); return end(); }
      const model = process.env.GEMINI_MODEL || "gemini-1.5-pro";
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: system + "\n\n" + userPrompt }]}] })
      });
      const data = await resp.json();
      const reply = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join("") || "";
      if (reply) addEntry(day, { role: "ai", message: reply, date: new Date().toISOString() });
      send({ text: reply || "" }); return end();
    }

    send({ error: "Fournisseur inconnu" }); return end();
  } catch (e) {
    console.error(e);
    send({ error: "Erreur serveur" }); return end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur sur le port ${PORT}`));
