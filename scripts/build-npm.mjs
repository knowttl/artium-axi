import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const metadata = JSON.parse(readFileSync('package.json', 'utf8'))
const directory = process.argv[2] ?? 'dist/npm'
rmSync(directory, { recursive: true, force: true })
mkdirSync(`${directory}/bin`, { recursive: true })
execFileSync(process.execPath, ['scripts/build-cli.mjs', `${directory}/bin/artium-axi.mjs`], { stdio: 'inherit' })
chmodSync(`${directory}/bin/artium-axi.mjs`, 0o755)
cpSync('skill/artium-axi', `${directory}/skill/artium-axi`, { recursive: true })
for (const file of ['README.md', 'LICENSE']) copyFileSync(file, `${directory}/${file}`)
writeFileSync(`${directory}/package.json`, JSON.stringify({
  name: '@knowttl/artium-axi', version: metadata.version,
  description: 'Client CLI and embedded skill for the Artium managed tools server.',
  license: metadata.license, type: 'module', engines: metadata.engines,
  bin: { 'artium-axi': 'bin/artium-axi.mjs' },
  files: ['bin/artium-axi.mjs', 'skill/artium-axi/SKILL.md', 'README.md', 'LICENSE', 'NOTICE'],
  repository: { type: 'git', url: 'git+https://github.com/knowttl/artium-axi.git' },
  publishConfig: { access: 'public' },
}, null, 2) + '\n')
const notices = ['zod', '@toon-format/toon'].map(name => {
  const dependency = JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8'))
  return `${name} ${dependency.version}\n\n${readFileSync(`node_modules/${name}/LICENSE`, 'utf8')}`
})
writeFileSync(`${directory}/NOTICE`, 'Bundled third-party software\n\n' + notices.join('\n'))
console.log(`npm: staged @knowttl/artium-axi@${metadata.version} in ${directory}`)
