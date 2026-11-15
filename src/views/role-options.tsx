export interface RoleOption { id: string, name: string, detail: string }

export function RoleOptions({ legend, roles, selected }: { legend: string, roles: RoleOption[], selected: string[] }) {
  return (
    <fieldset className="options">
      <legend>{legend}</legend>
      <input type="hidden" name="roleIds" disabled />
      {roles.length ? roles.map(role => (
        <label key={role.id} className="check">
          <input type="checkbox" name="roleIds" value={role.id} defaultChecked={selected.includes(role.id)} />
          <span><strong>{role.name}</strong><span>{role.detail}</span></span>
        </label>
      )) : <p className="hint">No roles yet. Create a role on Roles to grant tool access.</p>}
    </fieldset>
  )
}
