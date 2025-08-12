# Build minimal pour déployer CoachBot
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production --no-audit --no-fund

COPY . .

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
