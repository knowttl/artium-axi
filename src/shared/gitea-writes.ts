import inventory from '../../tools/inventories/gitea-axi.json' with { type: 'json' }

export const giteaTransferOperations = ['gitea.issue.download', 'gitea.pr.download', 'gitea.release.download'] as const
export const giteaTransferBytes = 10_000_000
export const giteaWriteOperations = [...inventory.apiRoutes.filter(route => route.effect === 'write').map(route => route.operation),
  ...giteaTransferOperations]
