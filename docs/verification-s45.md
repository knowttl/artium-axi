# S45 setup and embedded skill

Setup installs the embedded base skill and fetches reviewed upstream skill adaptations for every tool granted to the signed-in account, with an opt-in verified Claude Code hook.
It does not add download or launcher distribution.

Claude Code, Codex and OpenCode host contracts checked on 2026-10-08; Pi installer paths are defined by [setup.ts](../src/cli/setup.ts):

| Host | Personal skill path | Hook support in this installer | Authority |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/artium-axi/SKILL.md` | `~/.claude/settings.json`, `hooks.SessionStart[].hooks[]`, `type: command`, Node executable with `args: [bundle, tools]` | [Skills](https://code.claude.com/docs/en/skills#choose-where-skills-load), [hooks configuration](https://code.claude.com/docs/en/hooks#configuration), [command fields](https://code.claude.com/docs/en/hooks#command-hook-fields), [SessionStart](https://code.claude.com/docs/en/hooks#sessionstart) |
| Codex | `~/.agents/skills/artium-axi/SKILL.md` | Unsupported; no settings written | [Official skill locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) |
| OpenCode | `~/.config/opencode/skills/artium-axi/SKILL.md` | Unsupported; no settings written | [Official skill locations](https://opencode.ai/docs/skills/#place-files) |
| Pi | `~/.pi/agent/skills/artium-axi/SKILL.md` | Unsupported; no settings written | [Installer contract](../src/cli/setup.ts) |

The Claude paths above are defaults: when `CLAUDE_CONFIG_DIR` is nonempty, setup installs `skills/artium-axi/SKILL.md` and, with `--hook`, merges `settings.json` under that directory instead.
Relative `CLAUDE_CONFIG_DIR` values resolve against the setup process's working directory.
When `PI_CODING_AGENT_DIR` is nonempty, setup installs `skills/artium-axi/SKILL.md` under that directory instead.
Relative Pi directory values resolve against the setup process's working directory; a leading `~` or `~/` expands to the user's home directory.
Each granted tool uses a sibling `skills/<tool>/SKILL.md` directory under the same host location.

Claude Code's documented exec form passes paths as argument tokens without a shell.
The installer identifies its own hook by the documented `statusMessage` field and repairs that hook's executable paths on reinstallation.
Other settings, events and handlers survive the merge.
Plain stdout from a successful SessionStart command is session context, so the hook uses the existing counted tools view.
Hook execution still depends on Claude's workspace trust and host policy; setup does not change those controls.
No universal hook schema is assumed for Codex, OpenCode or Pi.

The Markdown source is imported as text by esbuild and included inside `dist/cli/artium-axi.mjs`.
The existing build-input digest includes `skill/`, and the Docker build context copies it before bundling.
There is no generated second copy of the base skill to become stale.
The installed base skill contains a Node invocation for the current bundle and a checksum comment, with no companion files.
`GET /v1/skills` uses the same authentication and current-grant filter as tool discovery.
The server reads npm-package skills from `/opt/tools` and the Falcon skill copied from its pinned source during the image build.
The overlays in `src/server/tool-skills.ts` bind each review to the upstream content digest, retain operational guidance, remove standalone credential setup, filter command tables to managed capabilities and prefix command examples with `artium-axi <tool>`.
Missing or changed upstream content fails the entire download before local installation.
Every installed skill uses the same checksum ownership marker and edited/unmanaged refusal.
Re-running setup adds new grants and reports retained Artium-managed skills for tools no longer granted without deleting them.
Unmanaged standalone skills outside the current grants are left untouched and unreported.
See [README setup guidance](../README.md) for managed-path repair and explicit skill replacement.
All validation of settings and skill ownership precedes writes.
All changed files are staged before replacement and atomically renamed, with their original modes preserved and temporary files removed.
If a replacement fails, completed replacements are rolled back from staged backups.

`test/cli-setup.test.ts` runs the production bundle copied into a temporary directory without source files or node_modules.
It checks all supported fresh-home paths, the base skill with no grants, repeat-install byte and modification-time stability, edited/unmanaged skill refusal and force replacement, unrelated Claude settings and hooks, moved bundle repair, malformed settings refusal, unsupported-hook explanations and usage errors without writes.
It also checks relocated Claude configuration with and without hooks and executes the recorded invocation from a replacement-sensitive bundle path.
Pi cases cover absolute, relative and tilde directory overrides, repeat-install stability and edited/unmanaged skill refusal with explicit force replacement.
Granted-skill cases cover new grants on re-run for every host, retained skills after grant removal and whole-install refusal when a later tool skill is edited or unmanaged.
`test/tool-skills.test.ts` checks the reviewed overlays against pinned upstream content, including a byte-identical Falcon source fixture, and refuses unreviewed content.
`test/integration/tool-skills.test.ts` checks authentication, changing grants, disabled tools, unavailable runtimes and all-or-nothing downloads, plus a standalone CLI re-run after a role grant changes.
`test/cli.test.ts` and `test/integration/api.test.ts` retain their direct bundle coverage with the Markdown loader enabled.

Actual Windows and macOS host execution remains deferred captain evidence after the full build.
The earlier implementation probe recorded an isolated fresh Codex session with only the installed artium-axi skill loading it, running `tools`, inspecting `tools show falcon-axi` and running `falcon-axi detection list` against a fake loopback HTTPS endpoint without command guidance.
The probe disabled repository instructions and user configuration for the session.
Claude Code 2.1.295 executed the installed hook with `--init-only`, made one fake `/v1/tools` request and recorded the counted tool view in its hook debug output without a model call.
These earlier probe notes are not evidence for the current gate run.
Pi 1.2.0 discovery was verified on Linux in offline RPC sessions: `get_commands` listed `skill:artium-axi` from both the default directory and a relocated `PI_CODING_AGENT_DIR`.
That discovery check does not establish skill usefulness, hook usefulness or captain live acceptance; other host/platform combinations require separate acceptance.
The required fresh-session re-drive, final candidate local checks, private hygiene and container evidence belong in the delivery report.
