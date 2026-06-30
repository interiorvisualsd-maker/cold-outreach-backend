# ─────────────────────────────────────────────────────────────────
# Lead Dispatcher — Backend Dockerfile (Google Cloud Run)
# Uses Bun runtime for fast startup and low memory footprint.
# ─────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS base

WORKDIR /app

# Copy dependency files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Generate Prisma client
RUN bunx prisma generate

# Cloud Run sets PORT env var; our server reads it
ENV PORT=8080
EXPOSE 8080

# Health check (optional — Cloud Run probes the container)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the API server (worker runs separately as Cloud Run Job)
CMD ["bun", "src/server.ts"]
