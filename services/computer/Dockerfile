# The Bot's computer uses Playwright's image so Chromium and its system libraries stay matched.
#
# The image tag and Playwright dependency must be pinned to the same exact version. Bump both or
# neither.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# unzip is not in the Playwright image and bun's installer needs it.
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY services/computer/package.json services/computer/bun.lock ./
RUN bun install --frozen-lockfile

COPY services/computer/src ./src

# Durable, separate data roots. Keeping the browser profile out of the tool-visible
# workspace prevents file tools from reading browser storage and session data.
RUN mkdir -p /workspace /profiles
ENV WORKSPACE_DIR=/workspace
ENV PROFILES_DIR=/profiles
VOLUME ["/workspace", "/profiles"]

ENV PORT=4100
EXPOSE 4100
# Readiness is exposed through Docker health so the supervisor need not know the network route.
HEALTHCHECK --interval=2s --timeout=3s --start-period=2s --retries=30 \
  CMD bun -e "const r = await fetch('http://localhost:4100/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
