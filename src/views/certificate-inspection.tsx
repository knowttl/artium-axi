import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Field } from '@astryxdesign/core/Field'
import { HStack } from '@astryxdesign/core/HStack'
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import type { z } from 'zod'
import type { certificateInspectionSchema } from '../shared/api.js'
import { ActionForm, MessageArea, type FormMessageState } from './action-form.js'
import { Icon } from './icon.js'

export type CertificateInspection = z.infer<typeof certificateInspectionSchema>

export interface TrustOptions {
  fills: boolean
  caOption: string
}

interface InspectionProps {
  csrf: string
  path: string
  trust: TrustOptions
}

function Line({ text, alert }: { text: string, alert?: boolean }) {
  return <Text as="p" role={alert ? 'alert' : undefined}>{text}</Text>
}

function InspectionBody({ csrf, path, trust, inspection }: InspectionProps & { inspection: CertificateInspection }) {
  const [message, setMessage] = useState<FormMessageState | null>(null)
  const { chain, anchor, nameChange, trustMode, rotation, pinRequired, verificationError } = inspection
  const leaf = chain[0]!
  const hasCA = rotation && trustMode === 'ca' || anchor.ca && anchor.fingerprint !== leaf.fingerprint
  const trustable = pinRequired || (trustMode ? rotation : verificationError !== null)
  const defaultMode = pinRequired ? 'pin' : rotation && trustMode ? trustMode : hasCA ? 'ca' : leaf.selfSigned ? 'pin' : ''
  const caUnavailable = verificationError !== null && !hasCA && !leaf.selfSigned
  return (
    <VStack gap={3}>
      <div data-certificate-details="">
        <VStack gap={1}>
          <Line text={`Hostname: ${inspection.hostname}`} />
          <Line text={inspection.reason} />
          {nameChange?.refusalReason && <Line text={nameChange.refusalReason} alert />}
          <Line text={`Leaf expires: ${leaf.expiresAt}`} />
          <Line text={`Trust anchor expires: ${anchor.expiresAt}`} />
          {inspection.warnings.map((warning, index) => <Line key={index} text={warning} alert />)}
          {inspection.previousFingerprints.map((fingerprint, index) => <Line key={index} text={`Previously trusted endpoint SHA-256: ${fingerprint}`} />)}
          {chain.map(certificate => (
            <section key={certificate.fingerprint}>
              <VStack gap={0.5}>
                <Heading level={3}>{certificate.subject}</Heading>
                <Line text={`Issuer: ${certificate.issuer}`} />
                <Line text={`Names: ${certificate.subjectAlternativeNames || 'No subject alternative names'}`} />
                <Line text={`Hostname matches: ${certificate.matchesHostname}`} />
                <Line text={`Valid from: ${certificate.validFrom}; expires: ${certificate.expiresAt}`} />
                <Line text={`Expired: ${certificate.expired}; not yet valid: ${certificate.notYetValid}`} />
                <Line text={`Key: ${certificate.keyType} ${certificate.keyBits ?? 'unknown'} bits; signature: ${certificate.signatureAlgorithm}`} />
                <Line text={`Self-signed: ${certificate.selfSigned}; CA: ${certificate.ca}`} />
                <label className="field">
                  <span>SHA-256 fingerprint (select to copy)</span>
                  <input className="input mono" readOnly value={certificate.fingerprint} onClick={event => event.currentTarget.select()} />
                </label>
              </VStack>
            </section>
          ))}
          {verificationError !== null && anchor.fingerprint !== leaf.fingerprint && <Line text={`Issuing CA to trust: ${anchor.subject}; SHA-256: ${anchor.fingerprint}`} />}
          {rotation && <Line text="Confirm the new fingerprint to replace saved trust. The existing trust mode is preserved." alert />}
          {caUnavailable && <Line text="CA trust is unavailable because no issuing CA was obtained. Choose strict leaf pinning explicitly." alert />}
        </VStack>
      </div>
      <MessageArea message={message} />
      {nameChange && !nameChange.refusalReason && (
        <ActionForm action={`${path}/certificates/use-name`} method="POST" csrf={csrf} onMessage={setMessage}>
          <input type="hidden" name="inspectionId" value={inspection.inspectionId} />
          <Button type="submit" label={`Use ${nameChange.certificateName} as the name and keep connecting to ${nameChange.connectAddress}`} variant="secondary" data-use-certificate-name="" />
        </ActionForm>
      )}
      {trustable && (
        <ActionForm action={`${path}/certificates/trust`} method="POST" csrf={csrf} retestUrl={`${path}/test`} onMessage={setMessage} attributes={{ 'data-trust-certificate': '' }}>
          <VStack gap={3}>
            <input type="hidden" name="inspectionId" value={inspection.inspectionId} />
            <input type="hidden" name="fillFields" data-type="boolean" value={String(trust.fills)} />
            <input type="hidden" name="replace" data-type="boolean" value={String(rotation)} />
            <Text as="p" type="supporting">
              {trust.fills ? 'Initial trust fills Certificate verification. Replacement preserves the existing trust mode.'
                : 'This tool does not support a shared trusted certificate field. Confirmed endpoint trust is available.'}
            </Text>
            <Field label="Trust mode" inputID="certificate-trust-mode" description="Self-signed endpoints keep a leaf pin. Hostname and date verification always apply.">
              <select id="certificate-trust-mode" name="mode" className="select" defaultValue={defaultMode} required>
                {defaultMode === '' && <option value="" disabled>Choose a trust mode</option>}
                <option value="ca" disabled={pinRequired || !hasCA || rotation && trustMode !== 'ca'}>{trust.caOption}</option>
                <option value="pin" disabled={rotation && trustMode !== 'pin'}>Strict leaf pinning (re-trust after every rotation)</option>
              </select>
            </Field>
            <label className="check"><input type="checkbox" name="confirmedFingerprint" value={leaf.fingerprint} required /> I compared the displayed SHA-256 fingerprint with the appliance through a trusted route.</label>
            <div><Button type="submit" label={rotation ? 'Replace trusted certificate' : 'Trust this certificate'} variant="primary" /></div>
          </VStack>
        </ActionForm>
      )}
    </VStack>
  )
}

export function CertificateInspectionDialog({ name, inspection, onClose, ...props }: InspectionProps & { name: string, inspection: CertificateInspection | null, onClose: () => void }) {
  return (
    <Dialog id="certificate-inspection" isOpen={inspection !== null} onOpenChange={open => { if (!open) onClose() }} purpose="form" width={640} maxHeight="90dvh">
      <Layout
        header={<DialogHeader title={`Inspect certificate for ${name}`} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Banner status="warning" icon={<Icon name="alert" />} title="Compare the fingerprint before trusting" role="alert"
                description="Trust is only as safe as the network path when this certificate was fetched. A certificate presented during interception would be trusted too. Compare the full SHA-256 fingerprint with the one shown by the appliance." />
              {inspection && <InspectionBody key={inspection.inspectionId} {...props} inspection={inspection} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end"><Button type="button" label="Close" variant="ghost" onClick={onClose} data-close-certificate="" /></HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}
