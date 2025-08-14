# Build minimal pour déployer CoachBot
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production --no-audit --no-fund

COPY . .

# Ne définissez pas PORT ici : Render fournit sa propre variable
# Ne spécifiez pas EXPOSE pour un port fixe
# Votre server.js lit process.env.PORT || 3000

CMD ["node", "server.js"]
