FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /opt/artium
COPY package.json pnpm-lock.yaml ./
COPY tools /opt/tools
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild argon2 better-sqlite3 esbuild && pnpm --dir /opt/tools install --frozen-lockfile
RUN --network=none /opt/tools/node_modules/.bin/ado-axi --version
RUN python3 -m venv /opt/falcon-build && python3 -m venv /opt/falcon-axi
RUN /opt/falcon-build/bin/pip download --require-hashes --only-binary=:all: --platform any --python-version 3.11 -r /opt/tools/build-requirements.txt -d /build-wheels && /opt/falcon-build/bin/pip download --require-hashes --only-binary=:all: --platform any --python-version 3.11 -r /opt/tools/requirements.txt -d /runtime-wheels
RUN node --input-type=module -e 'import {readFileSync} from "node:fs"; import {execFileSync} from "node:child_process"; const pin=JSON.parse(readFileSync("/opt/tools/falcon-source.json")); for(const args of [["init","/source"],["-C","/source","remote","add","origin",pin.repository],["-C","/source","fetch","--depth=1","origin",pin.commit],["-C","/source","checkout","--detach",pin.commit]]) execFileSync("git",args,{stdio:"inherit"})'
RUN --network=none /opt/falcon-build/bin/pip install --no-index --find-links=/build-wheels --require-hashes -r /opt/tools/build-requirements.txt
WORKDIR /source
RUN mkdir -p /opt/tools/skills/falcon-axi && cp skills/falcon-axi/SKILL.md /opt/tools/skills/falcon-axi/SKILL.md
RUN --network=none /opt/falcon-build/bin/python -m hatchling build -t wheel
RUN --network=none /opt/falcon-axi/bin/pip install --no-index --find-links=/runtime-wheels --require-hashes -r /opt/tools/requirements.txt && /opt/falcon-axi/bin/pip install --no-deps --no-index dist/falcon_axi-0.3.0-py3-none-any.whl && /opt/falcon-axi/bin/pip check
WORKDIR /opt/artium
COPY tsconfig.json ./
COPY src ./src
COPY skill ./skill
COPY bin ./bin
COPY tools/inventories ./tools/inventories
COPY scripts/build-cli.mjs ./scripts/build-cli.mjs
COPY scripts/native-smoke.mjs ./scripts/native-smoke.mjs
COPY scripts/falcon-smoke.mjs ./scripts/falcon-smoke.mjs
COPY test/fake-service/certificates.mjs ./test/fake-service/certificates.mjs
RUN --network=none node scripts/native-smoke.mjs
RUN pnpm exec tsc src/server/main.ts src/server/maintenance.ts --rootDir . --outDir dist --module NodeNext --target ES2022 --strict --resolveJsonModule --esModuleInterop --skipLibCheck && cp -R src/server/store/migrations dist/src/server/store/ && node scripts/build-cli.mjs && chmod +x bin/artium-axi-server

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 artium && mkdir /data && chown artium:artium /data
COPY --from=builder /opt/falcon-axi /opt/falcon-axi
COPY --from=builder /opt/tools /opt/tools
COPY --from=builder /opt/artium /opt/artium
ENV PATH="/opt/artium/bin:/opt/falcon-axi/bin:/opt/tools/node_modules/.bin:$PATH"
WORKDIR /opt/artium
USER artium
EXPOSE 8080
CMD ["node", "dist/src/server/main.js"]
