declare module '*@knowttl/ldap-axi/dist/src/schema.js' {
  type Schema = {
    summary: string
    booleanFlags: string[]
    valueFlags: string[]
    fields: { name: string, attributes: string[] }[]
    defaultFields: string[]
    requiredAttributes?: string[]
    flagAttributes?: Record<string, string[]>
  }
  type Flavor = 'ad' | 'adlds' | 'ldapv3'
  export function userListSchema(flavor: Flavor): Schema
  export function userShowSchema(flavor: Flavor): Schema
  export function userGroupsSchema(flavor: Flavor): Schema
  export function groupListSchema(flavor: Flavor): Schema
  export function groupShowSchema(flavor: Flavor): Schema
  export function groupMembersSchema(flavor: Flavor): Schema
  export function computerListSchema(flavor: Flavor): Schema
  export function computerShowSchema(flavor: Flavor): Schema
  export function completeSchema(...schemas: Schema[]): Schema
  export function commandHelp(command: string, ad: Schema, ldapv3: Schema, globalNames: string[]): string
}
