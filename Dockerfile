# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────
# Stage 1 — Build the React/Vite frontend
# ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS frontend
WORKDIR /app
# Combined single-container deploy: the frontend is served from the same origin
# as the API, so it calls /api/* relatively. Empty VITE_API_URL => relative URLs.
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# → /app/dist

# ─────────────────────────────────────────────────────────────
# Stage 2 — Install server dependencies (incl. dev deps)
# The server runs on `tsx` and migrates with `node-pg-migrate`, both of which
# are devDependencies, so a production-only install would break it at runtime.
# Native modules (bcrypt) build here; toolchain stays out of the final image.
# ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS server-deps
WORKDIR /app/server
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --include=dev

# ─────────────────────────────────────────────────────────────
# Stage 3 — Runtime image
# ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000 \
    SERVE_STATIC_DIR=/app/dist \
    FILE_STORAGE_DIR=/app/storage
COPY server/ ./server/
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY --from=frontend /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/storage
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
