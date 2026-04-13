# goClaw Agent Container — multi-stage Docker build
# Standalone agent runtime powered by the Claude Agent SDK
# Includes Chromium for browser tools, AWS CLI for S3 persistence

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build

COPY package.json tsconfig.json ./
COPY src/ src/

RUN npm install && npm run build && npm prune --production

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

# System dependencies (Chromium for agent-browser, AWS CLI for S3 sync)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    tini \
    curl \
    git \
    ca-certificates \
    awscli \
    inotify-tools \
    && rm -rf /var/lib/apt/lists/*

# Chromium paths for agent-browser / Playwright
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Global npm packages
RUN npm install -g agent-browser @anthropic-ai/claude-code

# ── Application ──────────────────────────────────────────────────────────────
WORKDIR /app/goclaw-agent

# Copy built artifacts and production dependencies
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./

# Copy scripts and config
COPY scripts/ /app/scripts/
COPY config/ /app/config/
RUN chmod +x /app/scripts/*.sh

# ── Workspace ────────────────────────────────────────────────────────────────
RUN mkdir -p \
    /workspace/group \
    /workspace/global \
    /workspace/extra \
    /workspace/ipc/messages \
    /workspace/ipc/tasks \
    /workspace/ipc/input

# Copy platform prompt into workspace
RUN cp /app/config/platform-prompt.md /workspace/global/CLAUDE.md

# Claude Code settings (auto-allow permissions for container use)
RUN mkdir -p /workspace/group/.claude
COPY config/claude-settings.json /workspace/group/.claude/settings.json

# ── Non-root user ────────────────────────────────────────────────────────────
RUN chown -R node:node /app /workspace && chmod 777 /home/node
USER node

WORKDIR /workspace/group

# ── Health check ─────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

EXPOSE 3000

# ── Entrypoint ───────────────────────────────────────────────────────────────
# tini handles signal forwarding; entrypoint.sh manages S3 sync lifecycle
ENTRYPOINT ["tini", "--", "/app/scripts/entrypoint.sh"]
