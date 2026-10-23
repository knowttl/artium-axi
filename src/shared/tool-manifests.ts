import falcon from '../../tools/inventories/falcon-axi.json' with { type: 'json' }
import vectra from '../../tools/inventories/vectra-axi.json' with { type: 'json' }
import az from '../../tools/inventories/az-axi.json' with { type: 'json' }
import mg from '../../tools/inventories/mg-axi.json' with { type: 'json' }
import ldap from '../../tools/inventories/ldap-axi.json' with { type: 'json' }
import ado from '../../tools/inventories/ado-axi.json' with { type: 'json' }
import awx from '../../tools/inventories/awx-axi.json' with { type: 'json' }
import tenable from '../../tools/inventories/tenable-axi.json' with { type: 'json' }
import hybrid from '../../tools/inventories/hybrid-axi.json' with { type: 'json' }

export const toolManifests = { 'falcon-axi': falcon, 'vectra-axi': vectra, 'az-axi': az, 'mg-axi': mg, 'ldap-axi': ldap, 'ado-axi': ado, 'awx-axi': awx, 'tenable-axi': tenable, 'hybrid-axi': hybrid }
