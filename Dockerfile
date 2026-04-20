FROM node:20-alpine AS base

# Install security updates
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# ============================================================
# Dependencies Stage
# ============================================================
FROM base AS deps

WORKDIR /app

COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci --only=production && \
    npm cache clean --force

# ============================================================
# Production Stage
# ============================================================
FROM base AS production

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY package*.json ./

# Create necessary directories
RUN mkdir -p /app/logs /app/uploads/products && \
    chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use dumb-init as PID 1 to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "src/server.js"]
