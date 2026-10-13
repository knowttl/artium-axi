---
name: artium-axi
description: Discover and run managed commands through Artium, using the signed-in account and its granted tools.
---

Use artium-axi tools first for requests involving data from Artium-managed tools.
Run `artium-axi tools` to discover the tools available to this account before choosing a tool.
Run `artium-axi tools show <tool>` for its commands and a vetted example, then run `artium-axi <tool> <args>`.
Follow the returned next commands; they already include the Artium prefix.
Keep upstream arguments intact and use the managed credentials rather than configuring an upstream CLI directly.

If artium-axi is absent from PATH, use the installed command below in place of `artium-axi` in every example:

<!-- artium-axi executable -->
The setup command records the standalone bundle's Node invocation here.
<!-- /artium-axi executable -->

If sign-in is required, ask the user to sign in with `artium-axi login --username <username> --password-stdin`.
Never request or print tokens or put passwords in arguments.
An empty tool list means no enabled runtime tool is available through the account's roles; ask an administrator to check grants and enabled tools.
Use `artium-axi doctor` for connection or cached health diagnostics.
Do not retry an uncertain command outcome, especially a write.
