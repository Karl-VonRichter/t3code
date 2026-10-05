FROM rust:1-bookworm AS resource-monitor
WORKDIR /build
COPY native/resource-monitor/ ./
RUN cargo build --locked --release

FROM node:24-bookworm-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.10.0
WORKDIR /src
COPY . .
ENV CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1
ARG BUILD_VERSION
RUN if [ -n "$BUILD_VERSION" ]; then node scripts/update-release-package-versions.ts "$BUILD_VERSION"; fi
RUN pnpm install --frozen-lockfile --filter=t3... --filter=@t3tools/web... --filter=@t3tools/scripts...
RUN pnpm exec vp run --filter=t3 build
# Generate a portable runtime with the versions from the workspace lockfile.
RUN pnpm --filter=t3 deploy --prod --config.inject-workspace-packages=true /opt/t3

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git gh openssh-client ripgrep python3 make g++ libsecret-1-0 tini \
    && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION=0.160.0
ARG CLAUDE_VERSION=2.1.288
RUN npm install --global --allow-scripts=@anthropic-ai/claude-code \
    "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force
COPY --from=build /opt/t3 /opt/t3
COPY --from=resource-monitor /build/target/release/t3-resource-monitor /opt/t3/dist/resource-monitor/t3-resource-monitor
RUN printf '#!/bin/sh\nexec node /opt/t3/dist/bin.mjs "$@"\n' > /usr/local/bin/t3 \
    && chmod +x /usr/local/bin/t3 \
    && mkdir -p /workspace /home/node/.t3 /home/node/.codex /home/node/.claude \
    && chown -R node:node /workspace /home/node
ENV NODE_ENV=production \
    T3CODE_HOME=/home/node/.t3
USER node
WORKDIR /workspace
EXPOSE 3773
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:3773/ >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "t3"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3773"]
