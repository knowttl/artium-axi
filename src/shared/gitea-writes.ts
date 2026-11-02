import inventory from '../../tools/inventories/gitea-axi.json' with { type: 'json' }

// Protected values and attachment custody are admitted separately.
export const giteaWriteOperations = inventory.apiRoutes.filter(route => route.effect === 'write'
  && !/Secret|Variable|Attachment/.test(route.operation)).map(route => route.operation)
