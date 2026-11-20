FROM node:22-bookworm-slim AS builder

WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable \
    && corepack prepare pnpm@11.25.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm --filter @codexdeck/server deploy --prod --legacy /tmp/server-package \
    && pnpm --filter @codexdeck/ops-mcp deploy --prod --legacy /tmp/ops-package \
    && mkdir -p /out/apps/server /out/apps/web /out/packages/ops-mcp \
    && cp -a /tmp/server-package/dist /tmp/server-package/node_modules /tmp/server-package/package.json /out/apps/server/ \
    && cp -a /tmp/ops-package/dist /tmp/ops-package/node_modules /tmp/ops-package/package.json /out/packages/ops-mcp/ \
    && cp -a apps/web/dist /out/apps/web/ \
    && rm -rf /tmp/server-package /tmp/ops-package

FROM node:22-bookworm-slim AS runtime

ARG INSTALL_PLAYWRIGHT=false
ARG CODEX_VERSION=0.157.1
ENV NODE_ENV=production \
    CODEXDECK_HOST=0.0.0.0 \
    CODEXDECK_PORT=3000 \
    CODEXDECK_DATA_DIR=/data \
    CODEXDECK_WORKSPACES=/workspaces \
    HOME=/data/home \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_CACHE=/data/caches/npm \
    PIP_CACHE_DIR=/data/caches/pip \
    UV_CACHE_DIR=/data/caches/uv

WORKDIR /app
COPY --from=builder --chown=0:0 /out/ /app/

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gosu git iproute2 python3 python3-venv ripgrep jq \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian %s stable\n' \
      "$(dpkg --print-architecture)" "$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")" \
      > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && npm install --global "@openai/codex@$CODEX_VERSION" \
    && if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
      node /app/apps/server/node_modules/playwright-core/cli.js install --with-deps chromium; \
    fi \
    && rm -rf /var/lib/apt/lists/* /root/.npm /data/caches/npm

RUN mkdir -p /data/home /workspaces /data/caches/npm /data/caches/pip /data/caches/uv \
    && chown -R 1000:1000 /data /workspaces
COPY --chmod=0755 deploy/entrypoint.sh /usr/local/bin/codexdeck-entrypoint

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/codexdeck-entrypoint"]
CMD ["node", "/app/apps/server/dist/index.js"]
