FROM node:24-slim

WORKDIR /app

# The runtime has no npm dependencies (Node built-ins + web-standard APIs only), but
# `npm ci --omit=dev` keeps the lockfile honest and future-proofs a dependency addition.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV STORAGE_DIRECTORY=/data

EXPOSE 8080

CMD ["node", "--import", "./src/host/register.mjs", "./src/host/main.mjs"]
