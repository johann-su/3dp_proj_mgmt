FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs && apk add --no-cache su-exec

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# SQL migrations + runner, applied on boot before the server starts
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# Stay root at boot: .next/cache is often a mounted volume, which Docker
# creates owned by root regardless of the --chown above (that only applies
# to files baked into the image). Fix the mount's ownership, then drop to
# the unprivileged nextjs user via su-exec before running the app.
CMD ["sh", "-c", "mkdir -p .next/cache && chown nextjs:nodejs .next/cache && exec su-exec nextjs sh -c 'node scripts/migrate.mjs && node server.js'"]
