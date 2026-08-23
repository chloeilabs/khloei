FROM oven/bun:1.3.11-alpine

WORKDIR /app
COPY services/agent-worker/package.json services/agent-worker/bun.lock ./
RUN bun install --frozen-lockfile

COPY shared ./shared
COPY services/agent-worker/src ./services/agent-worker/src

RUN mkdir -p /data
ENV AGENT_WORKER_DB_PATH=/data/tasks.sqlite
ENV NODE_ENV=production
ENV PORT=4200
VOLUME ["/data"]
EXPOSE 4200

HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4200/health'); process.exit(r.ok ? 0 : 1)"

WORKDIR /app/services/agent-worker
CMD ["bun", "src/index.ts"]
