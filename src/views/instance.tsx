import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Field } from '@astryxdesign/core/Field'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Heading, Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useEffect, useState } from 'react'
import { ActionForm, Revision } from './action-form.js'
import { CredentialEditor, type CredentialEditorProps } from './credential-editor.js'
import { Icon } from './icon.js'
import { GithubConnection, type GithubConnectionProps } from './github-connection.js'
import { Panel } from './panel.js'
import { badgeVariants, type Status } from './status.js'
import { LastChange, Time } from './time.js'
import { Setup, type ToolProps } from './tool.js'

interface Pin {
  id: string
  endpoint: string
  trust: string
  fingerprint: string
  endpointFingerprint: string | null
  note: string | null
  subject: string
  expires: string
  endpointExpires: string | null
}

export interface InstanceProps {
  csrf: string
  tool: string
  product: string
  mark: string
  api: string
  path: string
  toolRevision: number
  id: string
  name: string
  revision: number
  enabled: boolean
  state: Status
  outcomes: { ok: Status, error: Status }
  writes: Status
  checkedAt: string | null
  setup: (ToolProps['setup'][number] & { test?: boolean })[]
  failure: { shown: boolean, summary: string, code: string, certificateHint: boolean, diagnostic: string }
  github: GithubConnectionProps | null
  controllerOrigin: string | null
  connection: CredentialEditorProps
  certificates: {
    saved: boolean
    intro: string
    expiring: boolean
    pins: Pin[]
    offered: boolean
    endpoints: string[]
    trust: { fills: boolean, caOption: string }
  }
  testGuide: string
  change: { actor: string, at: string | null, revision: number } | null
}

function Versions({ id, revision }: Pick<InstanceProps, 'id' | 'revision'>) {
  return (
    <>
      <input type="hidden" name="expectedId" value={id} />
      <Revision value={revision} />
    </>
  )
}

function Header({ csrf, tool, mark, path, id, name, revision, enabled, state, outcomes, writes, checkedAt: initialCheckedAt }: InstanceProps) {
  const [checkedAt, setCheckedAt] = useState(initialCheckedAt)
  useEffect(() => {
    const update = (event: Event) => setCheckedAt((event as CustomEvent<string | null>).detail)
    document.addEventListener('artium-check-time', update)
    return () => document.removeEventListener('artium-check-time', update)
  }, [])
  return (
    <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
      <HStack gap={3} vAlign="center">
        <span className="tool-ico lg" aria-hidden="true">{mark}</span>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <code>{tool}</code>
          <span data-tool-state=""><Badge label={state.word} variant={badgeVariants[state.tone]} /></span>
          <span hidden>
            <span data-outcome="ok"><Badge label={outcomes.ok.word} variant={badgeVariants[outcomes.ok.tone]} /></span>
            <span data-outcome="error"><Badge label={outcomes.error.word} variant={badgeVariants[outcomes.error.tone]} /></span>
          </span>
          <Badge label={writes.word} variant={writes.tone === 'warn' ? 'warning' : 'neutral'} />
          <Text as="span" type="supporting">
            {'Checked '}
            <span data-check-time=""><Time iso={checkedAt} empty="never" /></span>
          </Text>
        </HStack>
      </HStack>
      <HStack gap={2} vAlign="center">
        <ActionForm action={`${path}/test`} method="POST" csrf={csrf} attributes={{ 'data-test-tool': tool }}>
          <Button type="submit" label="Test connection" variant="secondary" icon={<Icon name="test" />} />
        </ActionForm>
        <ActionForm action={path} method="PATCH" csrf={csrf}
          confirmation={{ consequence: enabled ? `Disable ${name}? Calls to it fail with INSTANCE_DISABLED until you enable it again.` : `Enable ${name}? Agents who can use it can call it again.`,
            title: enabled ? 'Disable instance' : 'Enable instance', action: enabled ? 'Disable' : 'Enable' }}>
          <Versions id={id} revision={revision} />
          <input type="hidden" name="enabled" data-type="boolean" value={String(!enabled)} />
          <button type="submit" className="toggle" role="switch" aria-checked={enabled}><span className={`switch${enabled ? ' on' : ''}`} aria-hidden="true" />Enabled</button>
        </ActionForm>
      </HStack>
    </HStack>
  )
}

function Failure({ failure }: Pick<InstanceProps, 'failure'>) {
  return (
    <div data-check-failure="" hidden={!failure.shown} suppressHydrationWarning>
      <Banner status="error" icon={<Icon name="alert" />} title="Last test failed" collapsible={false}
        description={<span data-check-summary="" suppressHydrationWarning>{failure.summary}</span>}>
        <VStack gap={2}>
          <Text as="p">
            {'Agents calling this instance get '}
            <code data-check-error="" suppressHydrationWarning>{failure.code}</code>
            {failure.certificateHint ? '. Review the endpoint under Certificates below.' : '.'}
          </Text>
          <details>
            <summary>Show diagnostic</summary>
            <pre data-check-diagnostic="" suppressHydrationWarning>{failure.diagnostic}</pre>
          </details>
        </VStack>
      </Banner>
    </div>
  )
}

function Controller({ csrf, api, props, origin }: { csrf: string, api: string, props: InstanceProps, origin: string }) {
  const [value, setValue] = useState(origin)
  return (
    <ActionForm action={`${api}/origin`} method="PUT" csrf={csrf}
      confirmation={{ consequence: 'Save this controller address without sending credentials? A changed address removes the previous token and certificate trust.' }}>
      <Panel title="Controller address" description="For password sign-in, save the address first, then check its certificate and sign in below.">
        <VStack gap={3}>
          <Versions id={props.id} revision={props.revision} />
          <input type="hidden" name="expectedToolRevision" data-type="number" value={props.toolRevision} />
          <input type="hidden" name="instance" value={props.name} />
          <TextInput label="Controller HTTPS origin" htmlName="origin" type="url" value={value} onChange={setValue} {...{ required: true }} />
          <Text as="p" type="supporting">Changing the saved address removes the previous token and certificate trust.</Text>
          <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
            <Text type="supporting">Sends no credentials.</Text>
            <Button type="submit" label="Save controller address" variant="secondary" size="sm" />
          </HStack>
        </VStack>
      </Panel>
    </ActionForm>
  )
}

function Connection({ csrf, props }: { csrf: string, props: InstanceProps }) {
  const { tool, product, path, name, id, revision, toolRevision, connection } = props
  return (
    <ActionForm action={`${path}/credential`} method="PATCH" csrf={csrf} saveTool={tool} attributes={{ 'data-save-instance': name }}
      confirmation={{ consequence: 'Save this credential, retaining unchanged stored secrets for the same identity and keeping native settings?' }}>
      <Panel title="Connection" description={`How Artium signs in to ${product} for ${name}. Secrets are encrypted and never shown again.`}>
        <VStack gap={3}>
          <Versions id={id} revision={revision} />
          <input type="hidden" name="expectedToolRevision" data-type="number" value={toolRevision} />
          <CredentialEditor {...connection} />
          <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
            <label className="check"><input type="checkbox" data-save-and-test="" defaultChecked /> Test after saving</label>
            <Button type="submit" label="Save connection" variant="primary" size="sm" />
          </HStack>
        </VStack>
      </Panel>
    </ActionForm>
  )
}

function PinTable({ csrf, path, pins }: { csrf: string, path: string, pins: Pin[] }) {
  return (
    <Table aria-label="Trusted certificates" scrollWrapper={({ children }) => <div className="instances-list">{children}</div>}>
      <TableHeader>
        <TableRow isHeaderRow>
          <TableHeaderCell scope="col">Endpoint</TableHeaderCell>
          <TableHeaderCell scope="col">Trust</TableHeaderCell>
          <TableHeaderCell scope="col">Fingerprint (SHA-256)</TableHeaderCell>
          <TableHeaderCell scope="col">Expires</TableHeaderCell>
          <TableHeaderCell scope="col"><VisuallyHidden>Actions</VisuallyHidden></TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pins.map(pin => (
          <TableRow key={pin.id}>
            <TableCell data-label="Endpoint"><code>{pin.endpoint}</code></TableCell>
            <TableCell data-label="Trust"><Badge label={pin.trust} variant="neutral" /></TableCell>
            <TableCell data-label="SHA-256">
              <VStack gap={0.5}>
                <code>{pin.fingerprint}</code>
                {pin.endpointFingerprint && <Text type="supporting">{'Endpoint: '}<code>{pin.endpointFingerprint}</code></Text>}
                {pin.note && <Text type="supporting">{pin.note}</Text>}
                <Text type="supporting">{pin.subject}</Text>
              </VStack>
            </TableCell>
            <TableCell data-label="Expires">
              <VStack gap={0.5}>
                <span>{pin.expires}</span>
                {pin.endpointExpires && <Text type="supporting">{`Endpoint: ${pin.endpointExpires}`}</Text>}
              </VStack>
            </TableCell>
            <TableCell>
              <ActionForm action={`${path}/certificates`} method="DELETE" csrf={csrf}
                confirmation={{ consequence: 'Remove this endpoint trust record? Separately saved Certificate verification fields remain.' }}>
                <input type="hidden" name="id" value={pin.id} />
                <Button type="submit" label="Remove endpoint trust" variant="secondary" size="sm" />
              </ActionForm>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function InspectionDialog({ csrf, path, name, trust }: { csrf: string, path: string, name: string, trust: InstanceProps['certificates']['trust'] }) {
  return (
    <dialog id="certificate-inspection" className="modal" aria-labelledby="certificate-inspection-title">
      <VStack gap={3} className="modal-body">
        <Heading level={2} id="certificate-inspection-title">{`Inspect certificate for ${name}`}</Heading>
        <Banner status="warning" icon={<Icon name="alert" />} title="Compare the fingerprint before trusting" role="alert"
          description="Trust is only as safe as the network path when this certificate was fetched. A certificate presented during interception would be trusted too. Compare the full SHA-256 fingerprint with the one shown by the appliance." />
        <div className="legacy-island" data-certificate-details="" suppressHydrationWarning />
        <p data-certificate-error="" role="alert" suppressHydrationWarning />
        <ActionForm action={`${path}/certificates/use-name`} method="POST" csrf={csrf} attributes={{ 'data-certificate-name-form': '', hidden: true }}>
          <input type="hidden" name="inspectionId" />
          <Button type="submit" label="Use certificate name" variant="secondary" data-use-certificate-name="" />
        </ActionForm>
        <ActionForm action={`${path}/certificates/trust`} method="POST" csrf={csrf} attributes={{ 'data-trust-certificate': '', 'data-trust-test-url': `${path}/test` }}>
          <VStack gap={3}>
            <input type="hidden" name="inspectionId" />
            <input type="hidden" name="fillFields" data-type="boolean" value={String(trust.fills)} />
            <Text as="p" type="supporting">
              {trust.fills ? 'Initial trust fills Certificate verification. Replacement preserves the existing trust mode.'
                : 'This tool does not support a shared trusted certificate field. Confirmed endpoint trust is available.'}
            </Text>
            <Field label="Trust mode" inputID="certificate-trust-mode" description="Self-signed endpoints keep a leaf pin. Hostname and date verification always apply.">
              <select id="certificate-trust-mode" name="mode" className="select">
                <option value="ca">{trust.caOption}</option>
                <option value="pin">Strict leaf pinning (re-trust after every rotation)</option>
              </select>
            </Field>
            <label className="check"><input type="checkbox" name="confirmedFingerprint" required /> I compared the displayed SHA-256 fingerprint with the appliance through a trusted route.</label>
            <div><Button type="submit" label="Trust this certificate" variant="primary" /></div>
          </VStack>
        </ActionForm>
        <HStack justify="end"><Button type="button" label="Close" variant="ghost" data-close-certificate="" /></HStack>
      </VStack>
    </dialog>
  )
}

function Certificates({ csrf, path, name, certificates }: { csrf: string, path: string, name: string, certificates: InstanceProps['certificates'] }) {
  const { saved, intro, expiring, pins, offered, endpoints, trust } = certificates
  if (!saved) {
    return (
      <Panel title="Trusted certificates" description="Trust applies only to this instance’s saved endpoints.">
        <Text as="p" type="supporting">Save a connection first. Certificates are inspected at the saved endpoints.</Text>
      </Panel>
    )
  }
  return (
    <>
      <Panel title="Trusted certificates" description={intro}>
        <VStack gap={3}>
          {expiring && <Banner status="warning" icon={<Icon name="alert" />} title="A trusted certificate expires soon" role="alert"
            description="A trusted certificate has expired or expires within 30 days. Re-inspect this endpoint for rotation." />}
          {pins.length ? <PinTable csrf={csrf} path={path} pins={pins} />
            : <Text as="p" type="supporting">No certificates trusted for this instance. Hostname and expiry checks always apply.</Text>}
          <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
            <Text type="supporting">{offered ? 'Compare the fingerprint with the one the appliance shows before trusting.' : 'Inspection is offered after a connection test fails with a certificate error.'}</Text>
            {endpoints.length > 0 && (
              <ActionForm action={`${path}/certificates/inspect`} method="POST" csrf={csrf} attributes={{ 'data-inspect-certificate': '', hidden: !offered }}>
                <HStack gap={2} vAlign="center">
                  {endpoints.length > 1
                    ? <>
                      <label className="sr-only" htmlFor="endpoint-index">Saved TLS endpoint</label>
                      <select id="endpoint-index" name="endpointIndex" data-type="number" className="select">
                        {endpoints.map((endpoint, index) => <option key={index} value={index}>{endpoint}</option>)}
                      </select>
                    </>
                    : <>
                      <input type="hidden" name="endpointIndex" data-type="number" value={0} />
                      <code>{endpoints[0]}</code>
                    </>}
                  <Button type="submit" label="Inspect certificate" variant="secondary" size="sm" icon={<Icon name="cert" />} />
                </HStack>
              </ActionForm>
            )}
          </HStack>
        </VStack>
      </Panel>
      <InspectionDialog csrf={csrf} path={path} name={name} trust={trust} />
    </>
  )
}

export function Instance(props: InstanceProps) {
  const { csrf, api, path, name, product, tool, github, controllerOrigin, certificates, failure, testGuide, change } = props
  return (
    <VStack gap={4}>
      <Header {...props} />
      <Failure failure={failure} />
      <Setup setup={props.setup} />
      <p className="note" data-test-result="" role="status" suppressHydrationWarning>{''}</p>
      {github && <GithubConnection csrf={csrf} {...github} />}
      {controllerOrigin !== null && <Controller csrf={csrf} api={api} props={props} origin={controllerOrigin} />}
      <Connection csrf={csrf} props={props} />
      <Certificates csrf={csrf} path={path} name={name} certificates={certificates} />
      <Panel title="Danger zone">
        <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
          <VStack gap={0.5}>
            <Text as="p"><strong>Delete instance</strong></Text>
            <Text type="supporting">Permanent. Removes its credential, certificate trust and health. Calls that name it fail with INSTANCE_NOT_FOUND. Audit history is kept.</Text>
          </VStack>
          <ActionForm action={path} method="DELETE" csrf={csrf} successUrl={`/admin/tools/${tool}`}
            confirmation={{ consequence: `Delete ${name}? Its credential, certificate trust and health are removed. This cannot be undone.`, title: 'Delete instance', action: 'Delete', typedName: name }}>
            <Versions id={props.id} revision={props.revision} />
            <Button type="submit" label="Delete…" variant="ghost" size="sm" className="danger" icon={<Icon name="trash" />} />
          </ActionForm>
        </HStack>
      </Panel>
      <Panel title="What the test does">
        <Text as="p">Runs one harmless read: <code>{testGuide}</code>. It does not enable the tool or grant access.</Text>
      </Panel>
      <Panel title="Keeping secrets">
        <Text as="p">Leave a stored secret blank to keep it. Changing authentication, mode, kind, tenant, client or URL needs new secrets.</Text>
        {change && <LastChange {...change} />}
      </Panel>
    </VStack>
  )
}
