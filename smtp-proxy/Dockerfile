# Tiny Node.js image — no dependencies, fast cold start
FROM node:20-alpine

WORKDIR /app

# Copy the proxy server (single file, zero npm deps)
COPY server.js .

# Fly.io sets PORT env var — our server reads it
ENV PORT=8080
EXPOSE 8080

# Healthcheck — Fly.io uses this to know if the proxy is alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
