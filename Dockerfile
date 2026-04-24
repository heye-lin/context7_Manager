FROM node:22-alpine

ARG VERSION=0.1.0
ARG COMMIT=unknown
ARG BUILD_TYPE=docker

ENV NODE_ENV=production
ENV APP_VERSION=$VERSION
ENV APP_COMMIT=$COMMIT
ENV BUILD_TYPE=$BUILD_TYPE
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/heye-lin/context7_Manager"
LABEL org.opencontainers.image.version=$VERSION
LABEL org.opencontainers.image.revision=$COMMIT

RUN apk add --no-cache docker-cli docker-cli-compose

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY public ./public
COPY src ./src

EXPOSE 3000
CMD ["node", "src/server.js"]
