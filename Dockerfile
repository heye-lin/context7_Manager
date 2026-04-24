FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY public ./public
COPY src ./src

EXPOSE 3000
CMD ["node", "src/server.js"]
