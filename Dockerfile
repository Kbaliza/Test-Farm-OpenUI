# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Next.js app image.
#
# Build-time note: `next build` inlines every NEXT_PUBLIC_* value into the
# client bundle, so those must be passed as --build-arg. Server-only secrets
# (SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, ...) are read at runtime from the
# container env and must NOT be build args — that would bake them into layers.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
# puppeteer-core drives a browser but never downloads one. These are belt and
# braces in case a transitive `puppeteer` is pulled in again: without them npm
# fetches its own ~150MB Chromium into a layer, and the runner uses Debian's.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
COPY package.json package-lock.json ./
# `postinstall` runs `prisma generate`, so the schema must exist before install.
COPY prisma ./prisma
RUN npm ci

# ---------- builder ----------
FROM base AS builder
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runner ----------
FROM base AS runner

# Bills are downloaded as PDF files, and the PDF is made by printing the app's own
# /print/invoice page in a headless Chromium — so the document the customer gets is
# the document on screen, not a second drawing of it that would drift.
#
# Debian's chromium rather than puppeteer's download, for the same reasons
# Dockerfile.worker gives: the apt build works on amd64 and arm64 alike, and it has
# been running in production there for months. fonts-liberation supplies the
# metric-compatible Arial/Times the bill's stylesheet falls back to; without it
# every glyph renders as a box.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# --create-home, and HOME set to match.
#
# Chromium writes a crash database, a profile and caches under HOME. A --system
# user has no home directory made for it, so HOME pointed at a path that did not
# exist and the browser died on startup with "chrome_crashpad_handler: --database
# is required". The worker image never hit this because it runs as `node`, which
# the base image gives a real home.
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --create-home --home-dir /home/nextjs nextjs
ENV HOME=/home/nextjs

COPY --from=builder /app/public ./public
# `output: "standalone"` emits a self-contained server with only the traced deps.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Prisma's native query engine is loaded by path at runtime; Next's dependency
# tracing does not always pick it up, so copy the generated client explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
# puppeteer-core resolves parts of itself at runtime, which the standalone trace
# does not always follow. Copied whole: it is a few MB and carries no browser.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/puppeteer-core ./node_modules/puppeteer-core

# Stamped by the deploy so the box can be asked what it is actually running:
#
#   docker compose ... exec -T web printenv GIT_SHA
#
# Last in the stage on purpose — the value changes on every deploy, so putting it
# here leaves every layer above it cached.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
