FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 artium
WORKDIR /opt/artium
COPY package.json ./
COPY dist/src/server ./dist/src/server
COPY dist/src/shared ./dist/src/shared
COPY dist/tools/inventories/gh-axi.json ./dist/tools/inventories/gh-axi.json
COPY node_modules/.pnpm/zod@*/node_modules/zod ./node_modules/zod
COPY test/fake-tool ./test/fake-tool
COPY test/runner/probe.mjs ./test/runner/probe.mjs
USER artium
CMD ["node", "test/runner/probe.mjs"]
