# syntax=docker/dockerfile:1

# --- Builder stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Re-sync lockfile for linux/x64 platform, then install
COPY package.json package-lock.json ./
RUN npm install --package-lock-only --no-audit --no-fund && \
    npm ci --no-audit --no-fund

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# --- Runtime stage ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Use the linux-reconciled lockfile from builder
COPY package.json ./
COPY --from=builder /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy built server and public assets
COPY --from=builder /app/dist ./dist
COPY public ./public

# Expose port and start
EXPOSE 3000
CMD ["node", "dist/server.js"]
