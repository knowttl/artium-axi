import { Banner } from '@astryxdesign/core/Banner'
import { Card } from '@astryxdesign/core/Card'
import { HStack } from '@astryxdesign/core/HStack'
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@astryxdesign/core/Table'
import { Text } from '@astryxdesign/core/Text'
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden'
import { VStack } from '@astryxdesign/core/VStack'
import { Icon } from './icon.js'
import { Time } from './time.js'

export interface SignInMatchesProps {
  people: { href: string, name: string, initials: string, claimsAt: string }[]
  note: string
}

export function SignInMatches({ people, note }: SignInMatchesProps) {
  return (
    <VStack gap={4}>
      <Card role="region" aria-label="Matching people" padding={people.length ? 0 : undefined}>
        <VisuallyHidden as="h2">Matching people</VisuallyHidden>
        {people.length ? (
          <Table aria-label={`${people.length} matching ${people.length === 1 ? 'person' : 'people'}`} scrollWrapper={({ children }) => <div className="table-wrap">{children}</div>}>
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell scope="col">Person</TableHeaderCell>
                <TableHeaderCell scope="col">Claims recorded</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.map(person => (
                <TableRow key={person.href}>
                  <TableHeaderCell scope="row">
                    <HStack gap={2} vAlign="center">
                      <span className="avatar" aria-hidden="true">{person.initials}</span>
                      <a href={person.href}>{person.name}</a>
                    </HStack>
                  </TableHeaderCell>
                  <TableCell><Text type="supporting"><Time iso={person.claimsAt} /></Text></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <Text as="p">No one matches this rule in the saved sign-in claims.</Text>}
      </Card>
      <Banner status="info" role="status" icon={<Icon name="info" />} title="Where matches come from" description={note} />
    </VStack>
  )
}
