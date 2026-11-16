import { Fragment } from 'react'

export function Breakable({ text }: { text: string }) {
  return <>{text.split(/(?<=_)/).map((part, index) => <Fragment key={index}>{index > 0 && <wbr />}{part}</Fragment>)}</>
}

export function Mono({ children }: { children: string }) {
  return <span className="mono"><Breakable text={children} /></span>
}
