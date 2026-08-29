FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# The persistent data directory (/home/data) is intentionally NOT created in the
# image. On Azure App Service it must come from the persistent /home mount
# (WEBSITES_ENABLE_APP_SERVICE_STORAGE=true); an image-local /home/data would be
# an ephemeral, same-layer directory that the runtime storage gate rejects.
# Creating it here would only manufacture the exact trap that gate defends
# against, so the mount is the sole source of the data directory.
RUN groupadd --system watchtower && useradd --system --gid watchtower watchtower
COPY --from=build --chown=watchtower:watchtower /app/node_modules ./node_modules
COPY --from=build --chown=watchtower:watchtower /app/dist ./dist
COPY --from=build --chown=watchtower:watchtower /app/dist-server ./dist-server
COPY --from=build --chown=watchtower:watchtower /app/package.json ./package.json
USER watchtower
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/live`).then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]
CMD ["node", "dist-server/server/bootstrap.js"]
