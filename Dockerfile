# syntax=docker/dockerfile:1

# --- Builder stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps (skip dev tools in final image)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# --- Runtime stage ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Only copy production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy built server and public assets
COPY --from=builder /app/dist ./dist
COPY public ./public

# Expose port and start
EXPOSE 3000
CMD ["node", "dist/server.js"]
