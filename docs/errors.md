# Error reference

Generated from `src/shared/errors.ts` by `pnpm errors:generate`.
Do not edit manually.
Artium errors use TOON on CLI stdout and JSON over HTTP.
Completed upstream calls preserve stdout, stderr and the upstream exit code, with HTTP 200 and the upstream tool as source.

| Code | Source | HTTP | CLI exit | Message | Next step |
|---|---|---|---|---|---|
| STORE_SCHEMA_INVALID | artium-axi | 503 | 1 | The store schema is unsupported by this image. | Use the matching image, or restore the pre-upgrade backup into a new volume with its matching image and key. |
| BACKUP_FAILED | artium-axi | 500 | 1 | Database backup did not complete. | Check the source store and a writable backup directory; choose a new output file. |
| RESTORE_FAILED | artium-axi | 500 | 1 | Database restore did not complete. | Stop the destination server and use an empty new data volume, an intact backup and its matching master key. |
| CLI_OUTDATED | artium-axi | 426 | 1 | The CLI version is too old for this server. | Download the current CLI from /cli/artium-axi.mjs. |
| CERTIFICATE_INVALID | artium-axi | 503 | 1 | The server certificate could not be verified. | Check certificate trust or set ARTIUM_AXI_CA_FILE to the trusted CA file. |
| ADMIN_REQUIRED | artium-axi | 403 | 1 | Administrator capability is required. | Ask an administrator to perform this operation. |
| REVISION_CONFLICT | artium-axi | 409 | 1 | The record changed since it was read. | Read the current record revision and retry your edit. |
| LAST_ADMINISTRATOR | artium-axi | 409 | 1 | The last enabled administrator must remain enabled. | Enable another administrator before changing this account. |
| USERNAME_INVALID | artium-axi | 400 | 1 | The local username is invalid. | Supply a nonempty username without whitespace or control characters. |
| PASSWORD_FILE_INVALID | artium-axi | 400 | 1 | The password file is missing or unreadable. | Supply a readable UTF-8 password file containing the exact password, without an added newline. |
| BOOTSTRAP_INCONSISTENT | artium-axi | 503 | 1 | The store contains data without a bootstrap marker. | Stop the server and restore a consistent bootstrapped store and matching master key. |
| RECOVERY_FAILED | artium-axi | 500 | 1 | Administrator recovery did not complete. | Use an existing local username in a bootstrapped store, check the matching master key and inspect local storage. |
| PASSWORD_INVALID | artium-axi | 400 | 1 | The password must be non-empty and at most 512 UTF-8 bytes. | Enter a password of at most 512 UTF-8 bytes. |
| SIGN_IN_FAILED | artium-axi | 401 | 1 | The username or password is incorrect. | Check your username and password. |
| SSO_STATE_INVALID | artium-axi | 400 | 1 | The SSO sign-in request expired or was already used. | Start a new sign-in from this browser. |
| SSO_TOKEN_INVALID | artium-axi | 401 | 1 | The identity provider response could not be verified. | Start a new sign-in or ask an administrator to check provider settings. |
| SSO_NOT_INVITED | artium-axi | 403 | 1 | This identity is not linked to an artium account. | Ask an administrator for an invitation and open its link to sign in. |
| SSO_INVITE_INVALID | artium-axi | 403 | 1 | This invitation cannot be claimed by this identity. | Use the expected sign-in username or ask an administrator for a new invitation link. |
| SSO_PROVIDER_ERROR | artium-axi | 503 | 1 | SSO sign-in is unavailable. | Ask an administrator to check the provider configuration or try again later. |
| DEVICE_CODE_INVALID | artium-axi | 400 | 1 | The device code is invalid or was already used. | Run artium-axi login --sso to start a new request. |
| DEVICE_CODE_EXPIRED | artium-axi | 400 | 1 | The device request expired. | Run artium-axi login --sso to start a new request. |
| DEVICE_DENIED | artium-axi | 403 | 1 | The device request was denied. | Start a new sign-in only if you requested it. |
| DEVICE_POLL_LIMITED | artium-axi | 429 | 1 | The device request was polled too quickly. | Wait for the requested polling interval before polling again. |
| AUTH_RATE_LIMITED | artium-axi | 429 | 1 | The authentication attempt limit was reached. | Wait 15 minutes before trying again. |
| ACCOUNT_LOCKED | artium-axi | 429 | 1 | The account is temporarily locked. | Wait 15 minutes or ask an administrator to unlock the account. |
| REAUTH_REQUIRED | artium-axi | 401 | 1 | Recent identity confirmation is required. | In the browser, confirm at /reauth using Microsoft for SSO or your local password. Local CLI users confirm their password through /v1/auth/reauth. |
| CSRF_INVALID | artium-axi | 403 | 1 | The form token or request origin is invalid. | Reload the form on this server and submit it again. |
| AUTH_BUSY | artium-axi | 429 | 1 | The concurrent password hashing limit was reached. | Wait for an active authentication request to finish. |
| MAINTENANCE_BUSY | artium-axi | 503 | 1 | The store is held by another server or maintenance process. | Stop the server and wait for maintenance to finish before retrying. |
| MAINTENANCE_UNAVAILABLE | artium-axi | 503 | 1 | The store maintenance lock is unavailable. | Check data-volume capacity and permissions. |
| ROTATION_FAILED | artium-axi | 500 | 1 | Master key rotation did not complete. | Keep both keys. Inspect the durable key_rotations receipt and restart with its latest new_key_id, or the old key if no rotation committed. |
| CLIENT_CONFIG_INVALID | artium-axi | 400 | 2 | The CLI server configuration is invalid. | Set ARTIUM_AXI_URL to an HTTPS URL; optionally set ARTIUM_AXI_CA_FILE. |
| SESSION_STORAGE_UNAVAILABLE | artium-axi | 500 | 1 | Secure CLI session storage is unavailable. | Check your configuration folder permissions and capacity, then sign in again. |
| SESSION_SERVER_MISMATCH | artium-axi | 400 | 1 | The stored session belongs to a different server. | Restore ARTIUM_AXI_URL or use artium-axi logout before signing in to the new server. |
| SESSION_BUSY | artium-axi | 503 | 1 | Another CLI process holds the session lock. | Wait for the other CLI process. If all CLI processes exited, remove the session.lock directory in your artium-axi configuration folder. |
| SESSION_CHANGED | artium-axi | 409 | 1 | The signed-in user changed during this operation. | Check the signed-in identity before starting a new operation. |
| PASSWORD_CHANGE_REQUIRED | artium-axi | 409 | 1 | Change your temporary password before using tools. | Run artium-axi passwd --password-stdin. |
| SERVER_UNAVAILABLE | artium-axi | 503 | 1 | The CLI could not receive a server response. | Check the server address and certificate trust; confirm the previous call outcome before retrying. |
| INVALID_RESPONSE | artium-axi | 500 | 1 | The server returned an invalid response. | Check the server URL and API version. |
| DEV_AUTH_INVALID | artium-axi | 503 | 1 | Development authentication settings are unsupported. | Remove ARTIUM_AXI_DEV and ARTIUM_AXI_DEV_TOKEN_FILE and use local sign-in. |
| PROXY_HEADERS_UNTRUSTED | artium-axi | 400 | 1 | Forwarding headers came from an untrusted address. | Connect through the configured trusted proxy or remove forwarding headers. |
| NOT_FOUND | artium-axi | 404 | 1 | The endpoint does not exist. | Use a supported API endpoint and tool name. |
| AUDIT_UNAVAILABLE | artium-axi | 503 | 1 | The audit event could not be stored. | Ask the administrator to check audit storage capacity and availability. |
| TOKEN_INVALID | artium-axi | 401 | 1 | The token is invalid or revoked. | Sign in again to obtain a valid token. |
| TOKEN_EXPIRED | artium-axi | 401 | 1 | The token has expired. | Sign in again. |
| USER_DISABLED | artium-axi | 403 | 1 | The user is disabled. | Ask the administrator to enable the user. |
| TOOL_DISABLED | artium-axi | 403 | 1 | The tool is disabled. | Ask the administrator to enable the tool. |
| TOOL_NOT_GRANTED | artium-axi | 403 | 1 | The user has no role granting this tool. | Ask the administrator to assign a role granting the tool. |
| MASTER_KEY_INVALID | artium-axi | 503 | 1 | The master key is missing or invalid. | Supply a 32-byte master key file or a base64 master key. |
| CREDENTIAL_INVALID | artium-axi | 503 | 1 | A stored credential could not be authenticated or contains malformed JSON. | Restore the matching master key and an intact credential store containing valid credential JSON. |
| FLAG_BLOCKED | artium-axi | 400 | 2 | The arguments override the managed tool boundary. | Remove destination, tenant, credential or local configuration overrides. |
| CREDENTIAL_UNAVAILABLE | artium-axi | 503 | 1 | The tool credential is unavailable. | Ask the administrator to check the tool configuration and stored credentials. |
| INVALID_INPUT | artium-axi | 400 | 2 | The request input is invalid. | Check the request fields and content type. |
| UNSUPPORTED_INPUT | artium-axi | 400 | 2 | The input file is not a matching upload. | Upload the file using a reviewed input-file flag. |
| SECRET_IN_OUTPUT | artium-axi | 500 | 1 | A known secret was detected in tool output. | Check upstream output redaction before retrying. |
| SPAWN_FAILED | artium-axi | 500 | 1 | The upstream tool could not be started. | Check the configured executable and environment. |
| PROCESS_SIGNAL | artium-axi | 500 | 1 | The upstream tool ended on a signal. | Check the tool status before retrying. |
| TIMEOUT | artium-axi | 504 | 1 | The upstream tool exceeded its timeout. | Check the tool status before retrying. |
| UNKNOWN_OUTCOME | artium-axi | 504 | 1 | The write may have changed state before the tool stopped. | Check current state before trying again. |
| CANCELLED | artium-axi | 500 | 1 | The call was cancelled. | Check the tool status before retrying. |
| OUTPUT_LIMIT | artium-axi | 500 | 1 | The upstream tool exceeded the output limit. | Use a command that produces less output. |
| TOO_MANY_CALLS | artium-axi | 429 | 1 | The concurrent call limit was reached. | Wait for an active call to finish. |
| RUNNER_CLOSED | artium-axi | 503 | 1 | The runner is shutting down. | Wait for the server to become available. |
| TEMP_UNAVAILABLE | artium-axi | 503 | 1 | The private call inputs could not be created. | Check temporary storage capacity and permissions. |
| INTERNAL_ERROR | artium-axi | 500 | 1 | The server could not complete the request. | Contact the administrator with the request ID. |
