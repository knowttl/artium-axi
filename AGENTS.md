# AGENTS.md

- Every change ships through the no-mistakes pipeline configured in `.no-mistakes.yaml`; there is no hosted CI.
- Development runs only against fakes, synthetic identities and canary credentials. Never contact a real tenant, appliance or service.
- Keep code, docs and tests generic: no real employer hostnames, tenant names, secret names or credentials.
- Toolchain, scripts, native build approval and test commands are defined by `package.json`, with upstream pins in `tools/package.json` and `tools/falcon-source.json`; `pnpm check` runs the local aggregate, and the separate mandatory private hygiene and conditional container checks are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
