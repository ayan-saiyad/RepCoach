FROM node:22-bookworm-slim AS builder

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace

# `npm ci` validates the workspace lockfile before application sources are copied.
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY infra/package.json ./infra/package.json
RUN npm ci

COPY . .
RUN npm run dashboard:build

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN groupadd --system --gid 1001 repcoach && useradd --system --uid 1001 --gid repcoach repcoach
WORKDIR /app

COPY --from=builder --chown=repcoach:repcoach /workspace/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=repcoach:repcoach /workspace/apps/dashboard/.next/static ./apps/dashboard/.next/static

USER repcoach
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]
