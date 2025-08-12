import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data.sqlite');
const firstTime = !fs.existsSync(DB_PATH);
const db = new Database(DB_PATH);

if (firstTime) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      day INTEGER NOT NULL,
      user TEXT NOT NULL,
      bot TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_journal_user ON journal(user_id);
    CREATE INDEX IF NOT EXISTS idx_journal_day ON journal(day);
  `);
  console.log('SQLite initialisé à', DB_PATH);
}

export function ensureUser(userId){
  if(!userId) return;
  const exists = db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);
  if(!exists){
    db.prepare('INSERT INTO users (id) VALUES (?)').run(userId);
  }
}

export function addJournalEntry({user_id, ts, day, user, bot}){
  return db.prepare(`INSERT INTO journal (user_id, ts, day, user, bot) VALUES (?, ?, ?, ?, ?)`)
           .run(user_id, ts, day, user, bot);
}

export function listJournal(userId, limit=200){
  return db.prepare(`SELECT id, ts, day, user, bot FROM journal WHERE user_id=? ORDER BY id DESC LIMIT ?`)
           .all(userId, limit);
}

export function purgeJournal(userId){
  return db.prepare(`DELETE FROM journal WHERE user_id=?`).run(userId);
}

export default db;
