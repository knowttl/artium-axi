# AGENTS.md

- Every change ships through the no-mistakes pipeline configured in `.no-mistakes.yaml`; there is no hosted CI.
- Development runs only against fakes, synthetic identities and canary credentials. Never contact a real tenant, appliance or service.
- Keep code, docs and tests generic: no real employer hostnames, tenant names, secret names or credentials.
- Toolchain, scripts and test commands are defined by `package.json`; `pnpm check` runs the local aggregate.
