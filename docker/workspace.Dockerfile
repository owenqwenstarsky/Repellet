FROM node:22.22.3-bookworm-slim AS bridge
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY packages/bridge/package*.json ./
RUN npm ci
COPY tsconfig.base.json /tsconfig.base.json
COPY packages/bridge/tsconfig.json ./
# The standalone build has no monorepo dependency.
RUN sed -i 's#../../tsconfig.base.json#/tsconfig.base.json#' tsconfig.json
COPY packages/bridge/src ./src
RUN npm run build && npm prune --omit=dev
RUN npm install --prefix /opt/language-tools pyright@1.1.414 typescript@5.9.3 typescript-language-server@6.0.1 prettier@3.9.9
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git openssh-client ca-certificates curl wget ripgrep build-essential pkg-config procps tini libstdc++6 libssl3 libffi8 libbz2-1.0 libreadline8 libsqlite3-0 liblzma5 zlib1g libexpat1 && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 1000 --shell /bin/bash workspace && mkdir /workspace && chown workspace:workspace /workspace
COPY --from=bridge /usr/local /opt/repellet/node
COPY --from=bridge /build/dist /opt/repellet/bridge/dist
COPY --from=bridge /build/node_modules /opt/repellet/bridge/node_modules
COPY --from=bridge /build/package.json /opt/repellet/bridge/package.json
COPY --from=bridge /opt/language-tools /opt/language-tools
ENV HOME=/home/workspace
USER workspace
WORKDIR /workspace
EXPOSE 8787
ENTRYPOINT ["/opt/repellet/node/bin/node", "/opt/repellet/bridge/dist/index.js"]
