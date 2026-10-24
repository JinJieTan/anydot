# AnyDot relay + mobile web app, one image.
# Build from the repository root:  docker build -f apps/relay/Dockerfile -t aitech-relay .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @aitech/relay build \
 && pnpm --filter @aitech/mobile build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8090 HOST=0.0.0.0 DATA_DIR=/data MOBILE_DIR=/app/mobile
COPY --from=build /src/apps/relay/dist/server.mjs ./server.mjs
COPY --from=build /src/apps/mobile/dist ./mobile
# A new named volume copies this ownership, so the node user can write it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8090
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1
CMD ["node", "server.mjs"]
