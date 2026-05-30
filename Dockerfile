FROM node:20-alpine

WORKDIR /app

# Copie les fichiers de dépendances en premier (cache Docker)
COPY package*.json ./
RUN npm install --omit=dev

# Copie le code source
COPY server.js ./
COPY public ./public

EXPOSE 3001

CMD ["node", "server.js"]
