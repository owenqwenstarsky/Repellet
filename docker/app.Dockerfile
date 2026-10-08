FROM node:22.22.3-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci && npm run build && npm prune --omit=dev
FROM node:22.22.3-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/codex-protocol ./packages/codex-protocol
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
FROM docker:29.2.1-cli AS docker-cli
FROM node:22.22.3-bookworm-slim AS worker
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.160.0 && useradd --uid 1001 --create-home --shell /bin/bash agent
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx
ENV NODE_ENV=production WORKER_IN_DOCKER=true WORKSPACE_CONTEXT=/opt/workspace-context AGENT_ACCOUNTS_HOME=/var/lib/repellet-agent-accounts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/codex-protocol ./packages/codex-protocol
COPY --from=build /app/apps/worker ./apps/worker
COPY packages/bridge /opt/workspace-context/packages/bridge
COPY docker/agent-context /opt/workspace-context/docker/agent-context
COPY tsconfig.base.json /opt/workspace-context/tsconfig.base.json
COPY docker/agent-launch.cjs /opt/workspace-context/docker/agent-launch.cjs
COPY docker/workspace.Dockerfile /opt/workspace-context/docker/workspace.Dockerfile
EXPOSE 3002
CMD ["node", "apps/worker/dist/index.js"]
