# ==========================================
# Stage 1: Build & Prune Dependencies
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install openssl for Prisma engine
RUN apk add --no-cache openssl libc6-compat

# Copy package descriptors and prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for build)
RUN npm ci --legacy-peer-deps

# Generate Prisma Client
RUN npx prisma generate

# Copy source code and config
COPY tsconfig.json ./
COPY src ./src/

# Compile TypeScript to dist/
RUN npm run build

# Remove development dependencies to keep production footprint minimal
RUN npm prune --production --legacy-peer-deps

# ==========================================
# Stage 2: Hardened Production Runtime
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

# Install runtime dependencies: openssl (for Prisma), wget (for healthcheck), dumb-init (PID 1 signal forwarding)
RUN apk add --no-cache openssl wget dumb-init

# Security: Create non-root system group and user
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup appuser

# Create logs and uploads directory with proper ownership
RUN mkdir -p /app/logs /app/uploads && \
    chown -R appuser:appgroup /app

# Copy built application and production dependencies from builder stage
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/prisma ./prisma
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist

# Switch to non-root user
USER appuser

# Environment variables
ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# Docker healthcheck using the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8000/health || exit 1

# dumb-init handles PID 1 signal forwarding for clean process management
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start production server
CMD ["node", "dist/server.js"]
