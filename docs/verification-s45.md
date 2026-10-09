# S45 setup and embedded skill

T6.6 installs one embedded skill from the standalone CLI, with an opt-in verified Claude Code hook.
It does not add download or launcher distribution.

Host contracts checked on 2026-10-08:

| Host | Personal skill path | Hook support in this installer | Authority |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/skills/artium-axi/SKILL.md` | `~/.claude/settings.json`, `hooks.SessionStart[].hooks[]`, `type: command`, Node executable with `args: [bundle, tools]` | [Skills](https://code.claude.com/docs/en/skills#choose-where-skills-load), [hooks configuration](https://code.claude.com/docs/en/hooks#configuration), [command fields](https://code.claude.com/docs/en/hooks#command-hook-fields), [SessionStart](https://code.claude.com/docs/en/hooks#sessionstart) |
| Codex | `~/.agents/skills/artium-axi/SKILL.md` | Unsupported; no settings written | [Official skill locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) |
| OpenCode | `~/.config/opencode/skills/artium-axi/SKILL.md` | Unsupported; no settings written | [Official skill locations](https://opencode.ai/docs/skills/#place-files) |

Claude Code's documented exec form passes paths as argument tokens without a shell.
The installer identifies its own hook by the documented `statusMessage` field and repairs that hook's executable paths on reinstallation.
Other settings, events and handlers survive the merge.
Plain stdout from a successful SessionStart command is session context, so the hook uses the existing counted tools view.
Hook execution still depends on Claude's workspace trust and host policy; setup does not change those controls.
No universal hook schema is assumed for Codex or OpenCode.

The Markdown source is imported as text by esbuild and included inside `dist/cli/artium-axi.mjs`.
The existing build-input digest includes `skill/`, and the Docker build context copies it before bundling.
There is no generated second copy of the skill to become stale.
The installed skill contains a Node invocation for the current bundle and a checksum comment, with no companion files.
An unchanged managed skill can upgrade or repair its recorded path; changed or unmanaged text needs explicit `--force`.
All validation of settings and skill ownership precedes writes.
Each changed file is written to a unique sibling temporary file and atomically renamed, with its original mode preserved and temporary files removed.

`test/cli-setup.test.ts` runs the production bundle copied into a temporary directory without source files or node_modules.
It checks all three fresh-home paths, the single installed file, repeat-install byte and modification-time stability, edited/unmanaged skill refusal and force replacement, unrelated Claude settings and hooks, moved bundle repair, malformed settings refusal, unsupported-hook explanations and usage errors without writes.
`test/cli.test.ts` and `test/integration/api.test.ts` retain their direct bundle coverage with the Markdown loader enabled.

Actual Windows and macOS host execution remains unverified.
An isolated fresh Codex session with only the installed artium-axi skill loaded it, ran `tools`, inspected `tools show falcon-axi` and ran `falcon-axi detection list` against a fake loopback HTTPS endpoint without command guidance.
The probe disabled repository instructions and user configuration for the session.
Claude Code 2.1.295 executed the installed hook with `--init-only`, made one fake `/v1/tools` request and recorded the counted tool view in its hook debug output without a model call.
Final candidate local checks, private hygiene and container evidence belong in the delivery report.
