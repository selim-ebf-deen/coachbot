# Build minimal pour déployer CoachBot
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production --no-audit --no-fund

COPY . .

# Render injecte le port 10000 dans l'environnement pour les services Docker.
# Node lira cette variable via process.env.PORT dans server.js.
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
