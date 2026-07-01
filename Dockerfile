# Lead Dispatcher — Backend Dockerfile
# Works with Render.com, Google Cloud Run, or any Docker host.
# Uses Bun runtime for fast startup and low memory footprint.
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

# Make startup script executable
RUN chmod +x start.sh

# Render sets PORT automatically (usually 10000).
# Cloud Run sets PORT to 8080.
# server.ts reads from process.env.PORT, so this works everywhere.
EXPOSE 8080

# Run startup script: creates database tables, then starts server
CMD ["./start.sh"]
