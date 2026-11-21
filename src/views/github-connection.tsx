import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { ActionForm, ActionSubmit, Revision } from './action-form.js'
import { useGithubDevice } from './github-device.js'
import { Icon } from './icon.js'
import { Panel } from './panel.js'
import { Time } from './time.js'

export interface GithubConnectionProps {
  action: string
  toolRevision: number
  origin: string
  instance: { id: string, name: string, revision: number } | null
  connected: { login: string, expiresAt: string | null } | null
  expired: boolean
}

export function GithubConnection({ csrf, action, toolRevision, origin, instance, connected, expired }: GithubConnectionProps & { csrf: string }) {
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState(origin)
  const { device, connect, cancel } = useGithubDevice(action, csrf)
  const subject = instance ? 'this instance' : 'a new instance'
  return (
    <Panel title={`${connected ? 'Reconnect' : instance ? 'Connect' : 'Add an instance'} with GitHub`} description={`A machine identity for ${subject}.`}>
      <VStack gap={3}>
        <Text as="p">
          Use a dedicated machine account. This reuses the GitHub CLI OAuth client ID and requests repo, read:org, gist, workflow and project.
          These broad scopes permit writes outside Artium even while Artium writes are off.
        </Text>
        <Text as="p">
          The non-expiring OAuth token appears as GitHub CLI in GitHub Settings, Applications, Authorized OAuth Apps. Revoke it there.
          Store and rotate it like every other secret. No automatic refresh is performed.
          {` Connecting ${instance ? 'replaces this instance’s credential' : 'saves the new instance'} only after approval.`}
        </Text>
        {connected && (
          <Text as="p">
            {'Connected account: '}<strong>{connected.login}</strong>{'. '}
            {connected.expiresAt ? <>{'Provider expiry: '}<Time iso={connected.expiresAt} /></> : 'No scheduled expiry.'}
          </Text>
        )}
        {expired && <Banner status="error" icon={<Icon name="alert" />} title="The credential expired or was revoked" description="Reconnect below." role="alert" />}
        <ActionForm action={action} method="POST" csrf={csrf} showDevice={connect} attributes={{ 'data-connect-github': '' }}
          confirmation={{ consequence: `Connect a GitHub account with repo, read:org, gist, workflow and project scopes to ${instance
            ? 'this instance? This replaces its credential' : 'a new instance? The instance is created'} after authorization.` }}>
          <VStack gap={3}>
            {instance
              ? <>
                <input type="hidden" name="expectedId" value={instance.id} />
                <Revision value={instance.revision} />
                <input type="hidden" name="instance" value={instance.name} />
              </>
              : <>
                <Revision value={0} />
                <TextInput label="Instance name" htmlName="instance" value={name} onChange={setName} autoComplete="off" hasSpellCheck={false}
                  {...{ required: true, maxLength: 32, pattern: '[a-z0-9][a-z0-9\\-]*' }} />
              </>}
            <input type="hidden" name="expectedToolRevision" data-type="number" value={toolRevision} />
            <TextInput label="GitHub HTTPS origin" htmlName="origin" type="url" value={endpoint} onChange={setEndpoint} {...{ required: true }} />
            <div><ActionSubmit label={`${connected ? 'Reconnect' : 'Connect'} with GitHub`} variant="secondary" icon={<Icon name="link" />} /></div>
          </VStack>
        </ActionForm>
        <div data-github-authorization="" hidden={!device}>
          <VStack gap={2}>
            <Text as="p">Open <a className="link" data-github-link="" href={device?.connection.verificationUri} target="_blank" rel="noopener noreferrer">{device?.connection.verificationUri}</a>{' and enter:'}</Text>
            <Text as="p" type="code" size="2xl" weight="bold"><span data-github-code="">{device?.connection.userCode}</span></Text>
            <Text as="p"><span data-github-status="" role="status">{device?.status}</span></Text>
            <div><Button type="button" label="Cancel connection" variant="ghost" size="sm" isDisabled={!device?.cancellable} onClick={cancel} data-cancel-github="" /></div>
          </VStack>
        </div>
        {instance && <Text as="p" type="supporting">Alternatively, choose token or github-app below to replace the credential using another method.</Text>}
      </VStack>
    </Panel>
  )
}
