import falcon from '../../tools/inventories/falcon-axi.json' with { type: 'json' }
import vectra from '../../tools/inventories/vectra-axi.json' with { type: 'json' }
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }
import mg from '../../tools/inventories/mg-axi.json' with { type: 'json' }

export const toolManifests = { 'falcon-axi': falcon, 'vectra-axi': vectra, 'az-axi': az, 'mg-axi': mg }
