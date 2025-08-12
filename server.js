import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Chemin du fichier JSON dans le disque persistant
const FILE_PATH = process.env.DB_PATH || "/data/journal.json";

// Fonction utilitaire pour lire le journal
function loadJournal() {
  try {
    const data = fs.readFileSync(FILE_PATH, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return []; // Si le fichier n'existe pas ou est vide
  }
}

// Fonction utilitaire pour sauvegarder le journal
function saveJournal(entries) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(entries, null, 2));
}

// Route test pour vérifier que le serveur fonctionne
app.get("/", (_req, res) => {
  res.send("✅ CoachBot est en ligne !");
});

// Sauvegarde dans le journal
app.post("/api/journal/save", (req, res) => {
  const { message } = req.body;
  const journal = loadJournal();
  journal.push({ message, date: new Date().toISOString() });
  saveJournal(journal);
  res.json({ success: true });
});

// Lecture du journal
app.get("/api/journal", (_req, res) => {
  const journal = loadJournal();
  res.json(journal);
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});
