import { Badge } from '@astryxdesign/core/Badge'
import { Banner } from '@astryxdesign/core/Banner'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, ActionSubmit, ActionToggle, Revision } from './action-form.js'
import { CertificateInspectionDialog, type CertificateInspection, type TrustOptions } from './certificate-inspection.js'
import { CredentialEditor, type CredentialEditorProps } from './credential-editor.js'
import { Icon } from './icon.js'
import { GithubConnection, type GithubConnectionProps } from './github-connection.js'
import { Panel } from './panel.js'
import { badgeVariants, type Status } from './status.js'
import { LastChange, Time } from './time.js'
import { TestOutcomeProvider, TestResultNote, useTestHealth, useTestOutcome } from './test-outcome.js'
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
    alwaysOfferInspection: boolean
    endpoints: string[]
    trust: TrustOptions
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

function Header({ csrf, tool, mark, path, id, name, revision, enabled, state, outcomes, writes, checkedAt }: InstanceProps) {
  const { show } = useTestOutcome()
  const health = useTestHealth()
  const shown = health ? outcomes[health.passed ? 'ok' : 'error'] : state
  return (
    <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
      <HStack gap={3} vAlign="center">
        <span className="tool-ico lg" aria-hidden="true">{mark}</span>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <code>{tool}</code>
          <span data-tool-state=""><Badge label={shown.word} variant={badgeVariants[shown.tone]} /></span>
          <Badge label={writes.word} variant={writes.tone === 'warn' ? 'warning' : 'neutral'} />
          <Text as="span" type="supporting">
            {'Checked '}
            <span data-check-time=""><Time iso={health ? health.checkedAt : checkedAt} empty="never" /></span>
          </Text>
        </HStack>
      </HStack>
      <HStack gap={2} vAlign="center">
        <ActionForm action={`${path}/test`} method="POST" csrf={csrf} showTest={show} attributes={{ 'data-test-tool': tool }}>
          <ActionSubmit label="Test connection" variant="secondary" icon={<Icon name="test" />} />
        </ActionForm>
        <ActionForm action={path} method="PATCH" csrf={csrf}
          confirmation={{ consequence: enabled ? `Disable ${name}? Calls to it fail with INSTANCE_DISABLED until you enable it again.` : `Enable ${name}? Agents who can use it can call it again.`,
            title: enabled ? 'Disable instance' : 'Enable instance', action: enabled ? 'Disable' : 'Enable' }}>
          <Versions id={id} revision={revision} />
          <input type="hidden" name="enabled" data-type="boolean" value={String(!enabled)} />
          <ActionToggle enabled={enabled} />
        </ActionForm>
      </HStack>
    </HStack>
  )
}

function Failure({ failure: saved }: Pick<InstanceProps, 'failure'>) {
  const health = useTestHealth()
  const failure = health ? { shown: health.errorCode !== null, summary: health.summary, code: health.errorCode ?? '', certificateHint: health.errorCode === 'UPSTREAM_TLS_FAILED',
    diagnostic: health.diagnostic } : saved
  return (
    <div data-check-failure="" hidden={!failure.shown}>
      <Banner status="error" icon={<Icon name="alert" />} title="Last test failed" collapsible={false}
        description={<span data-check-summary="">{failure.summary}</span>}>
        <VStack gap={2}>
          <Text as="p">
            {'Agents calling this instance get '}
            <code data-check-error="">{failure.code}</code>
            {failure.certificateHint ? '. Review the endpoint under Certificates below.' : '.'}
          </Text>
          <details>
            <summary>Show diagnostic</summary>
            <pre data-check-diagnostic="">{failure.diagnostic}</pre>
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
            <ActionSubmit label="Save controller address" variant="secondary" size="sm" />
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
            <label className="check"><input type="checkbox" name="testAfterSave" data-save-and-test="" defaultChecked /> Test after saving</label>
            <ActionSubmit label="Save connection" variant="primary" size="sm" />
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
                <ActionSubmit label="Remove endpoint trust" variant="secondary" size="sm" />
              </ActionForm>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function Certificates({ csrf, path, name, certificates, savedTlsFailure }: { csrf: string, path: string, name: string, certificates: InstanceProps['certificates'], savedTlsFailure: boolean }) {
  const { saved, intro, expiring, pins, alwaysOfferInspection, endpoints, trust } = certificates
  const { tlsFailed } = useTestOutcome()
  const [inspection, setInspection] = useState<CertificateInspection | null>(null)
  const inspectable = endpoints.length > 0 && (alwaysOfferInspection || (tlsFailed ?? savedTlsFailure))
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
            <Text type="supporting">{inspectable ? 'Compare the fingerprint with the one the appliance shows before trusting.' : 'Inspection is offered after a connection test fails with a certificate error.'}</Text>
            {endpoints.length > 0 && (
              <ActionForm action={`${path}/certificates/inspect`} method="POST" csrf={csrf} showInspection={setInspection} attributes={{ 'data-inspect-certificate': '', hidden: !inspectable }}>
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
                  <ActionSubmit label="Inspect certificate" variant="secondary" size="sm" icon={<Icon name="cert" />} />
                </HStack>
              </ActionForm>
            )}
          </HStack>
        </VStack>
      </Panel>
      <CertificateInspectionDialog csrf={csrf} path={path} name={name} trust={trust} inspection={inspection} onClose={() => setInspection(null)} />
    </>
  )
}

function InstanceSetup({ setup }: Pick<InstanceProps, 'setup'>) {
  const health = useTestHealth()
  if (!health) return <Setup setup={setup} />
  return <Setup setup={setup.map(step => step.test ? { ...step, state: health.passed ? 'done' : 'fail',
    detail: health.passed ? 'Passed' : `Failing: ${health.errorCode ?? 'error'}`, at: null } : step)} />
}

export function Instance(props: InstanceProps) {
  const { csrf, api, path, name, product, tool, github, controllerOrigin, certificates, failure, testGuide, change } = props
  return (
    <TestOutcomeProvider><VStack gap={4}>
      <Header {...props} />
      <Failure failure={failure} />
      <InstanceSetup setup={props.setup} />
      <TestResultNote />
      {github && <GithubConnection csrf={csrf} {...github} />}
      {controllerOrigin !== null && <Controller csrf={csrf} api={api} props={props} origin={controllerOrigin} />}
      <Connection csrf={csrf} props={props} />
      <Certificates csrf={csrf} path={path} name={name} certificates={certificates} savedTlsFailure={failure.certificateHint} />
      <Panel title="Danger zone">
        <HStack gap={3} justify="between" vAlign="center" wrap="wrap">
          <VStack gap={0.5}>
            <Text as="p"><strong>Delete instance</strong></Text>
            <Text type="supporting">Permanent. Removes its credential, certificate trust and health. Calls that name it fail with INSTANCE_NOT_FOUND. Audit history is kept.</Text>
          </VStack>
          <ActionForm action={path} method="DELETE" csrf={csrf} successUrl={`/admin/tools/${tool}`}
            confirmation={{ consequence: `Delete ${name}? Its credential, certificate trust and health are removed. This cannot be undone.`, title: 'Delete instance', action: 'Delete', typedName: name }}>
            <Versions id={props.id} revision={props.revision} />
            <ActionSubmit label="Delete…" variant="ghost" size="sm" className="danger" icon={<Icon name="trash" />} />
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
    </VStack></TestOutcomeProvider>
  )
}
