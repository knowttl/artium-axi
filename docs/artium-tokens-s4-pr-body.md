Delegated sessions need command scopes and discovery that reflect their grants.
This slice resolves exact and trailing wildcard selections through adapter resolvers, preserves credential and escape-hatch exclusions, and filters tools, identity, skills and CLI discovery.
Workflow-prefixed Kubernetes wildcards and Azure aliases retain their canonical descendants.
CLI help and command listings use the server's permitted set for delegated sessions, including Kubernetes and SSH local dispatch paths.

Discovery reflects token grants, current tool enablement, read-only restrictions and Allow writes.
GitHub also reflects its administrator operation allow-list.
Other adapter-internal operation allow-lists, including UniFi, Falcon, Gitea, Technitium, Proxmox and Kubernetes credential acquisition, remain enforced during execution and are not reflected in slice 4 discovery.
A shared pre-credential discovery policy hook across those adapters is a follow-up.
Minting remains disabled until the later rollout slice.

Focused regression cases cover CLI discovery, Kubernetes workflow wildcards and Azure aliases.
The outer pipeline owns validation and publication.
