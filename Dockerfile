FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /opt/artium
COPY package.json pnpm-lock.yaml ./
COPY tools /opt/tools
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild argon2 better-sqlite3 esbuild && pnpm --dir /opt/tools install --frozen-lockfile
RUN --network=none /opt/tools/node_modules/.bin/ado-axi --version
COPY scripts/install-gh.mjs ./scripts/install-gh.mjs
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    node scripts/install-gh.mjs
RUN --network=none /usr/local/bin/gh --version && /opt/tools/node_modules/.bin/gh-axi --version
RUN --network=none /opt/tools/node_modules/.bin/awx-axi --version
RUN --network=none /opt/tools/node_modules/.bin/tenable-axi --version
RUN --network=none /opt/tools/node_modules/.bin/checkpoint-axi --version
RUN --network=none /opt/tools/node_modules/.bin/beyondtrust-axi --version
RUN --network=none /opt/tools/node_modules/.bin/hybrid-axi --version
RUN --network=none node /opt/tools/node_modules/@knowttl/falcon-axi/.typescript-build/src/bin.js --version
RUN --network=none node /opt/tools/node_modules/@knowttl/kubernetes-axi/bin/kubernetes-axi.js --version
RUN --network=none node /opt/tools/node_modules/@knowttl/ssh-axi/dist/main.js --version
COPY tsconfig.json ./
COPY src ./src
COPY skill ./skill
COPY bin ./bin
COPY --chmod=0755 libexec/ado-axi/az ./libexec/ado-axi/az
COPY tools/inventories ./tools/inventories
RUN ln -s /opt/tools/node_modules tools/node_modules
COPY scripts/build-cli.mjs ./scripts/build-cli.mjs
COPY scripts/build-admin-client.mjs ./scripts/build-admin-client.mjs
COPY scripts/native-smoke.mjs ./scripts/native-smoke.mjs
COPY scripts/falcon-smoke.mjs ./scripts/falcon-smoke.mjs
COPY test/fake-service/certificates.ts ./test/fake-service/certificates.ts
RUN --network=none node scripts/native-smoke.mjs
RUN pnpm exec tsc src/server/main.ts src/server/maintenance.ts src/server/artifacts.ts src/server/runner/artifact.ts --rootDir . --outDir dist --module NodeNext --target ES2022 --strict --resolveJsonModule --esModuleInterop --skipLibCheck --jsx react-jsx && cp -R src/server/store/migrations dist/src/server/store/ && node scripts/build-admin-client.mjs && cp -R src/server/admin/client dist/src/server/admin/ && node scripts/build-cli.mjs && chmod +x bin/artium-axi-server

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 artium && mkdir /data && chown artium:artium /data
COPY --from=builder /usr/local/bin/gh /usr/local/bin/gh
COPY --from=builder /opt/tools /opt/tools
COPY --from=builder /opt/artium /opt/artium
ENV PATH="/opt/artium/bin:/opt/tools/node_modules/.bin:$PATH"
WORKDIR /opt/artium
USER artium
EXPOSE 8080
CMD ["node", "dist/src/server/main.js"]
