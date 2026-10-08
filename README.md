# artium-axi

artium-axi is one container that fronts several agent-ergonomic command-line tools behind a single login.
It adds role-based access to those tools and a command-line client that follows the AXI design principles.

Status: under construction.
Nothing is usable yet.
Installation and quick-start instructions arrive with the first working release.

The development scaffold requires Node 22.12 or later and pnpm 10.22.0, pinned in `package.json`.
Run `pnpm install --frozen-lockfile`, then `pnpm check` for strict type checking, the Vitest suite and TypeScript compilation into `dist/`.
`pnpm lint` performs only static checking, `pnpm test` runs the full suite, and `pnpm build` compiles the scaffold.
The executable toolchain tests compile synthetic TypeScript and run its emitted ESM with Node, and verify strict null checking rejects an invalid assignment.
`pnpm test:security` selects tests whose names contain `security`.
It allows an empty selection for now because no application security contracts exist yet.

`src/shared/`, `src/server/` and `src/cli/` reserve the application layout, and `test/` holds scaffold tests.
The server, CLI, container and upstream integrations arrive in later slices.
The `.no-mistakes.yaml` commands are `pnpm install --frozen-lockfile`, `pnpm test` and `pnpm lint`.
All application validation will use fakes and synthetic data, with live acceptance deferred.
