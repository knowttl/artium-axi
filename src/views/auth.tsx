import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Card } from '@astryxdesign/core/Card'
import { Code } from '@astryxdesign/core/Code'
import { Divider } from '@astryxdesign/core/Divider'
import { HStack } from '@astryxdesign/core/HStack'
import { Link } from '@astryxdesign/core/Link'
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Heading, Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { useState } from 'react'
import { useClientValue } from './client-value.js'
import { useCopy } from './copy.js'
import { Icon } from './icon.js'
import { Time } from './time.js'

export interface AuthButton {
  label: string
  tone: 'primary' | 'secondary' | 'ghost' | 'destructive'
  href?: string
  name?: string
  value?: string
  marker?: string
  back?: true
}

export interface AuthField {
  id: string
  name: string
  label: string
  type: 'text' | 'password'
  autoComplete: string
  hint?: string
  maxLength?: number
  mono?: true
}

export type AuthBlock =
  | { kind: 'text', parts: (string | { code: string })[], hint?: true }
  | { kind: 'divider', label: string }
  | { kind: 'banner', status: 'success' | 'warning', text: string }
  | { kind: 'code', value: string }
  | { kind: 'details', rows: { label: string, value: string, mono?: true, time?: true, copyLabel?: string }[] }
  | { kind: 'buttons', buttons: AuthButton[], row?: true }
  | { kind: 'form', action: string, fields: AuthField[], blocks: AuthBlock[], post?: { csrf: string, hidden?: Record<string, string> } }

export interface AuthProps {
  title: string
  description?: string
  mark?: { icon: string, tone: 'ok' | 'warn' | 'neutral' }
  brand: { name: string, href: string }
  blocks: AuthBlock[]
  footnote?: string
  signedIn?: { name: string, csrf: string, sso: boolean }
  help: string
  themeSwitch: string
}

function Field({ field }: { field: AuthField }) {
  const [value, setValue] = useState('')
  return <TextInput label={field.label} id={field.id} htmlName={field.name} type={field.type} value={value} onChange={setValue}
    autoComplete={field.autoComplete} description={field.hint} controlClassName={field.mono ? 'mono' : undefined} {...{ required: true, maxLength: field.maxLength }} />
}

function BackButton({ label, tone }: { label: string, tone: AuthButton['tone'] }) {
  const hasHistory = useClientValue(() => history.length > 1, false)
  return <Button label={label} variant={tone} width="100%" type="button" hidden={!hasHistory} onClick={() => history.back()} data-history-back="" />
}

function Buttons({ buttons, row }: { buttons: AuthButton[], row?: true }) {
  const items = buttons.map(({ label, tone, href, name, value, marker, back }) => back ? <BackButton key={label} label={label} tone={tone} /> : (
    <Button key={label} label={label} variant={tone} width="100%" href={href} name={name} value={value} {...marker ? { [marker]: '' } : {}}
      {...href ? {} : { type: 'submit' }} />
  ))
  return row ? <HStack gap={2}>{items}</HStack> : <VStack gap={2}>{items}</VStack>
}

function CopyValue({ value, label }: { value: string, label: string }) {
  const { source, status, copy } = useCopy<HTMLElement>()
  return (
    <span data-copy-scope="">
      <Text ref={source} type="code">{value}</Text>
      <Button type="button" variant="ghost" size="sm" label={`Copy ${label}`} onClick={copy} data-copy=""><Icon name="copy" /></Button>
      <span role="status" data-copy-status="">{status}</span>
    </span>
  )
}

function Block({ block }: { block: AuthBlock }) {
  switch (block.kind) {
    case 'text': return (
      <Text as="p" type={block.hint ? 'supporting' : 'body'}>
        {block.parts.map((part, index) => typeof part === 'string' ? part : <Code key={index}>{part.code}</Code>)}
      </Text>
    )
    case 'divider': return <Divider label={block.label} />
    case 'banner': return <Banner status={block.status} title={block.text} icon={<Icon name={block.status === 'success' ? 'check' : 'alert'} />} />
    case 'code': return <Card variant="muted"><div role="group" aria-label="Code"><Text as="p" type="code" size="3xl" weight="bold" justify="center">{block.value}</Text></div></Card>
    case 'details': return (
      <MetadataList columns="single">
        {block.rows.map(({ label, value, mono, time, copyLabel }) => (
          <MetadataListItem key={label} label={label}>
            {copyLabel ? <CopyValue value={value} label={copyLabel} /> : mono ? <Text type="code">{value}</Text> : time ? <Time iso={value} /> : value}
          </MetadataListItem>
        ))}
      </MetadataList>
    )
    case 'buttons': return <Buttons buttons={block.buttons} row={block.row} />
    case 'form': return (
      <form method={block.post ? 'post' : 'get'} action={block.action}>
        <VStack gap={3}>
          {block.post && <input type="hidden" name="_csrf" value={block.post.csrf} />}
          {Object.entries(block.post?.hidden ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          {block.fields.map(field => <Field key={field.id} field={field} />)}
          {block.blocks.map((inner, index) => <Block key={index} block={inner} />)}
        </VStack>
      </form>
    )
  }
}

export function Auth({ title, description, mark, brand, blocks, footnote, signedIn, help, themeSwitch }: AuthProps) {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <main id="main" className="auth">
        <div className="auth-wrap">
          <Card>
            <VStack gap={4}>
              {mark ? (
                <HStack gap={2} vAlign="center">
                  <span className={`ico-circle ${mark.tone === 'neutral' ? '' : mark.tone}`}><Icon name={mark.icon} /></span>
                  <Heading level={1} type="display-3">{title}</Heading>
                </HStack>
              ) : (
                <>
                  <Link href={brand.href}><HStack gap={2} vAlign="center"><span className="logo" aria-hidden="true">{brand.name[0]}</span>{brand.name}</HStack></Link>
                  <Heading level={1} type="display-3">{title}</Heading>
                </>
              )}
              {description && <Text as="p" type="supporting">{description}</Text>}
              {blocks.map((block, index) => <Block key={index} block={block} />)}
            </VStack>
          </Card>
          {footnote && <p className="auth-foot">{footnote}</p>}
          {signedIn && (
            <form className="auth-foot" method="post" action="/logout">
              <input type="hidden" name="_csrf" value={signedIn.csrf} />
              Signed in as {signedIn.name} · <Button type="submit" variant="ghost" size="sm" label="Sign out" />
              {signedIn.sso && <label className="check"><input type="checkbox" name="providerLogout" value="true" /> Also sign out of your identity provider</label>}
            </form>
          )}
          {themeSwitch && <div className="theme-row" dangerouslySetInnerHTML={{ __html: themeSwitch }} />}
          <details className="page-help auth-help"><summary>Need help?</summary><div dangerouslySetInnerHTML={{ __html: help }} /></details>
        </div>
      </main>
    </>
  )
}
