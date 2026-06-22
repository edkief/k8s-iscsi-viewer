# syntax=docker/dockerfile:1

# ---- base (pnpm via corepack) ----
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---- runner ----
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Standalone server binds to HOSTNAME; 0.0.0.0 so the Service can reach it.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Run as non-root.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Standalone output: server + minimal node_modules, plus static assets and public.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
