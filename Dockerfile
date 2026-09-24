FROM node:22-bookworm

ENV NODE_ENV=production \
    PORT=4646 \
    HOME=/home/cursorproxy \
    PATH=/home/cursorproxy/.local/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && mkdir -p /home/cursorproxy \
    && HOME=/home/cursorproxy bash -c 'curl https://cursor.com/install -fsS | bash' \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY scripts ./scripts
RUN npm install --global pnpm \
    && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm run build \
    && pnpm prune --prod

RUN useradd --create-home --shell /usr/sbin/nologin cursorproxy \
    && mkdir -p /home/cursorproxy/.cursor \
    && chown -R cursorproxy:cursorproxy /app /home/cursorproxy

USER cursorproxy

EXPOSE 4646
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:4646/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["node", "dist/server/standalone.js", "run", "4646"]
