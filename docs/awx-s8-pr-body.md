Projects support managed create/edit, sync and notification associations through the existing per-tenant writes switch, confirmation and AWX authorization checks.
SCM URLs use the private input channel, and create/edit reject userinfo, credential query parameters and fragments, including percent-encoded and apostrophe-containing values.
SCM secrets must be supplied through the S2 secure credential input path, using `credential create/edit --inputs-file` and the project's `--credential` reference.

Already-retained AWX logs from URLs set outside Artium are AWX-held data and remain outside Artium's SCM input protection.
This change does not scrub historical AWX logs or retain a history of SCM secrets.
Raw stdout keeps ordinary URLs intact and does not scan current projects for redaction values.

Focused regressions cover rejected inline and uploaded URLs on create/edit and preview/confirmed paths, clean URL acceptance, packaged private input, tool help, and ordinary log URLs through inferred and explicit project-update stdout, tail/lines and ad-hoc stdout.
