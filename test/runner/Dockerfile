FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 artium
WORKDIR /opt/artium
COPY package.json ./
COPY dist/src/server ./dist/src/server
COPY dist/src/shared ./dist/src/shared
COPY dist/tools/inventories/gh-axi.json ./dist/tools/inventories/gh-axi.json
COPY dist/tools/inventories/gitea-axi.json ./dist/tools/inventories/gitea-axi.json
COPY dist/tools/inventories/falcon-axi.json ./dist/tools/inventories/falcon-axi.json
COPY dist/tools/inventories/unifi-axi.json ./dist/tools/inventories/unifi-axi.json
COPY dist/tools/inventories/proxmox-axi.json ./dist/tools/inventories/proxmox-axi.json
COPY dist/tools/inventories/technitium-axi.json ./dist/tools/inventories/technitium-axi.json
COPY node_modules/.pnpm/zod@*/node_modules/zod ./node_modules/zod
COPY node_modules/.pnpm/@toon-format+toon@*/node_modules/@toon-format/toon ./node_modules/@toon-format/toon
COPY test/fake-tool ./test/fake-tool
COPY test/runner/probe.mjs ./test/runner/probe.mjs
USER artium
CMD ["node", "test/runner/probe.mjs"]
