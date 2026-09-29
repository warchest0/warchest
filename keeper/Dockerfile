# syntax=docker/dockerfile:1
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# dev dependencies are needed at runtime: the service runs TypeScript through tsx
RUN npm ci --include=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
