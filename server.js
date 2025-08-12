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

// Déterminer le répertoire courant lorsque l'on utilise ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chemin du fichier JSON dans le disque persistant
const FILE_PATH = process.env.DB_PATH || "/data/journal.json";

// Servir les fichiers statiques (interface web)
app.use(express.static(path.join(__dirname, 'public')));

// Fonction utilitaire pour lire le journal
function loadJournal() {
  try {
    const data = fs.readFileSync(FILE_PATH, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return [];
  }
}

// Fonction utilitaire pour sauvegarder le journal
function saveJournal(entries) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(entries, null, 2));
}

// Route d’accueil qui renvoie l’interface web
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Sauvegarde d’une entrée dans le journal
app.post('/api/journal/save', (req, res) => {
  const { message } = req.body;
  const journal = loadJournal();
  journal.push({ message, date: new Date().toISOString() });
  saveJournal(journal);
  res.json({ success: true });
});

// Lecture du journal complet
app.get('/api/journal', (_req, res) => {
  const journal = loadJournal();
  res.json(journal);
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
});
