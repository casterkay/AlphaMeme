FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production RADAR_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public/voice-alerts.mjs ./public/voice-alerts.mjs
COPY scripts/backup.mjs ./scripts/backup.mjs

# uid 1000, which owns the mounted data directory on the VPS.
USER node
CMD ["node", "src/host/main.mjs"]
