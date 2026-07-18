FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/storage/uploads /app/storage/pdfs && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
