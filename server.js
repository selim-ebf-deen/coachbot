import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || "/data/data.sqlite";

app.use(bodyParser.json());

// === Initialisation base SQLite ===
let db;
(async () => {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });
  await db.exec(`CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry TEXT,
    date TEXT
  )`);
  console.log(`SQLite initialisé à ${DB_PATH}`);
})();

// === Route test page d’accueil ===
app.get("/", (req, res) => {
  res.send("✅ CoachBot est en ligne et fonctionne !");
});

// === Sauvegarde dans le journal ===
app.post("/api/journal/save", async (req, res) => {
  const { entry } = req.body;
  const date = new Date().toISOString();
  await db.run("INSERT INTO journal (entry, date) VALUES (?, ?)", [entry, date]);
  res.json({ message: "Entrée enregistrée avec succès" });
});

// === Lecture du journal ===
app.get("/api/journal", async (_req, res) => {
  const rows = await db.all("SELECT * FROM journal ORDER BY date DESC");
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`CoachBot server listening on port ${PORT}`);
});
