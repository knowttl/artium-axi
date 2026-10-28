# Commands


This summary follows the [CLI help registry](../src/cli/help.ts); `artium-axi --help` prints its complete current command list.

| Command | Purpose |
| --- | --- |
| `artium-axi` | Identity, roles and available tools |
| `login --username <username>` / `login --sso` | Local password / browser approval |
| `passwd` / `logout` | Change password / remove local tokens and attempt revocation |
| `whoami` | Identity, roles, [session and access-token expiry](client-reference.md#toon-output-behavior) and server |
| `tools` / `tools show <tool>` | Granted enabled tools / pinned help and first call |
| `doctor` | Server, TLS, token, version and cached health; five-second request deadlines |
| `update` | Update the [server-downloaded client](client-reference.md#verified-client) |
| `download` | Preview and explicitly verify/save administrator-selected Hybrid Analysis archives, Check Point emails/attachments and Graph mail exports through the local CLI. Run `artium-axi download --help` for guards and warnings. |
| `setup --host <host>` | Install managed skills and optional Claude hook |
| `<tool> <args>` | Run any of the eleven managed tools |
| `--managed-session --help` | Private-pipe session protocol |

`artium-axi --help falcon-axi` is local help; `artium-axi falcon-axi --help` authenticates and calls upstream.
The [full client reference](client-reference.md#command-surface-and-subcommands) describes forwarding and supported input.
