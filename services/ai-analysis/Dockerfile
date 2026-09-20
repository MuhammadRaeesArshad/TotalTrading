# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN addgroup -S app && adduser -S app -G app
USER app

# Ollama is not in here — it owns the GPU and runs on the host. Reach it with
# OLLAMA_URL, which compose points at host.docker.internal.
EXPOSE 8003
CMD ["node", "dist/main"]
