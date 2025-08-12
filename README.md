# CoachBot 15 Jours — IA (OpenAI / Claude / Gemini) avec persistance SQLite

## Lancer en local
```bash
npm install
cp .env.example .env  # ajoutez vos clés
npm run dev
# http://localhost:8787
```

## Déploiement

### Render.com (recommandé pour débuter)
- Créez un nouveau Web Service depuis ce repo (ou zip).
- Sélectionnez Node 20+.
- Build command: `npm install`
- Start command: `node server.js`
- Ajoutez les variables d'env (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEFAULT_PROVIDER, DB_PATH=/data/data.sqlite).
- Ajoutez un disque persistant (1 GB) monté sur `/data`.
- Déployez.

### Vercel
- Ajoutez `vercel.json`.
- Set env vars dans le dashboard Vercel.
- Déployez — l'UI est servie via `public/`, les routes `/api/*` pointent vers `server.js`.

### Docker
```bash
docker build -t coachbot:latest .
docker run -p 8787:8787 --env-file .env -v $(pwd)/data:/data coachbot:latest
```

## Persistance
- SQLite se crée automatiquement au premier démarrage.
- Endpoints:
  - `POST /api/journal/save` body: `{ user_id, entries:[{ts, day, user, bot}] }`
  - `GET /api/journal?user_id=...` pour récupérer l'historique
  - `POST /api/journal/purge` body: `{ user_id }`

## Sécurité (à renforcer en prod)
- Générer un `user_id` côté client (localStorage). Pour la prod, ajouter une vraie auth (Magic Link, OAuth) et limiter les quotas.
- Protéger l'API par un middleware de rate-limit (ex: `express-rate-limit`).

## Personnalisation
- `systemPrompt()` dans `server.js` ajuste le style et les outils.
- Modèles: changez `gpt-4o-mini`, `claude-3-5-sonnet-20240620`, `gemini-1.5-pro` si besoin.
- UI: `public/index.html`.
```

