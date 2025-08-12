import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 📌 Initialisation SQLite
let db;
(async () => {
  db = await open({
    filename: "/data/data.sqlite",
    driver: sqlite3.Database
  });
  await db.exec(`CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    date TEXT
  )`);
  console.log("✅ SQLite prêt !");
})();

// 📌 Route test
app.get("/", (req, res) => {
  res.send("✅ CoachBot est en ligne !");
});

// 📌 Sauvegarde dans le journal
app.post("/api/journal/save", async (req, res) => {
  const { message } = req.body;
  await db.run("INSERT INTO journal (message, date) VALUES (?, datetime('now'))", message);
  res.json({ success: true });
});

// 📌 Lecture du journal
app.get("/api/journal", async (req, res) => {
  const entries = await db.all("SELECT * FROM journal ORDER BY date DESC");
  res.json(entries);
});

// 📌 Lancement serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});

Correction server.js SQLite
