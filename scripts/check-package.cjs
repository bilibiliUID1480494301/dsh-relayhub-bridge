/**
 * Packaging self-check: enforce the DeepSeek Harness plugin contract.
 *
 * Run with `node scripts/check-package.cjs` (also wired to `npm run check`).
 *
 * These are the rules the community registry and the Harness loader actually
 * apply. Failing them means the plugin silently never gets picked up, which is
 * a miserable thing to debug from the outside -- so they are checked here.
 */

const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const failures = []
const notes = []

/**
 * Record one check result.
 * @param {boolean} ok - whether the check passed.
 * @param {string} label - what was checked.
 * @param {string} [detail] - extra context for a failure.
 */
function check(ok, label, detail) {
  if (ok) notes.push(`  ok   ${label}`)
  else failures.push(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
}

const pkgPath = join(root, 'package.json')
check(existsSync(pkgPath), 'package.json exists')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// --- identity ---------------------------------------------------------------
check(/^dsh-/.test(pkg.name), 'npm name uses the dsh- prefix', pkg.name)
check(
  /^[a-z0-9][a-z0-9._-]*$/.test(pkg.name),
  'npm name is lowercase letters/digits/./_/-',
  pkg.name,
)
check(pkg.type === 'module', 'package is ESM (type: module)')
check(typeof pkg.version === 'string' && pkg.version.length > 0, 'version is set')

// The Host half reports its own version in the identity header, and the client
// half sends it in the join payload. A drift between the manifest and those
// constants ships a wrong version to the station, which is invisible until
// someone reads the logs -- so it is asserted here.
const indexSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const declaredVersion = /export const PLUGIN_VERSION = '([^']+)'/.exec(indexSource)
check(
  declaredVersion !== null && declaredVersion[1] === pkg.version,
  'lib/index.js PLUGIN_VERSION matches package.json version',
  `manifest ${pkg.version} vs index ${declaredVersion ? declaredVersion[1] : 'missing'}`,
)
const clientSourceForVersion = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const clientVersion = /const PLUGIN_VERSION = '([^']+)'/.exec(clientSourceForVersion)
check(
  clientVersion !== null && clientVersion[1] === pkg.version,
  'lib/client.js PLUGIN_VERSION matches package.json version',
  `manifest ${pkg.version} vs client ${clientVersion ? clientVersion[1] : 'missing'}`,
)
check(
  Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'),
  'keywords include dsh-plugin',
)

// --- the dsh block: the single mandatory declaration ------------------------
check(pkg.dsh && typeof pkg.dsh === 'object', 'dsh block is declared')
const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
check(typeof patch === 'string' && patch.length > 0, 'dsh.bundle.patch is a non-empty string', String(patch))
if (typeof patch === 'string' && patch.length > 0) {
  // The loader requires a relative path that does not escape the package.
  check(!patch.startsWith('/') && !/^[a-zA-Z]:/.test(patch), 'dsh.bundle.patch is not absolute', patch)
  check(!patch.split(/[\\/]/).includes('..'), 'dsh.bundle.patch does not contain ..', patch)
  check(patch.startsWith('./'), 'dsh.bundle.patch is written as ./-relative', patch)
  const patchPath = join(root, patch.replace(/^\.\//, ''))
  check(existsSync(patchPath), `dsh.bundle.patch target exists (${patch})`)
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, 'utf8')
    check(/insert:/.test(text), 'patch inserts a loader row')
    check(/dsh-relayhub-bridge/.test(text), 'patch references this package name')
  }
}

// --- entry points -----------------------------------------------------------
const main = pkg.main || (pkg.exports && pkg.exports['.'] && pkg.exports['.'].default)
check(typeof main === 'string' && existsSync(join(root, main)), 'main entry exists', String(main))
const types = pkg.types || (pkg.exports && pkg.exports['.'] && pkg.exports['.'].types)
check(typeof types === 'string' && existsSync(join(root, types)), 'types entry exists', String(types))

// --- Client half ------------------------------------------------------------
// A UI plugin ships a browser artifact beside the Host entry. The manifest
// declares it under `dsh.client`, and it must be exported as `./client`.
const client = pkg.dsh && pkg.dsh.client
if (client === undefined) {
  notes.push('  --   no dsh.client section (Host-only plugin)')
} else {
  check(typeof client === 'object', 'dsh.client is an object')
  check(client.platform === 'web', 'dsh.client.platform is web', String(client.platform))
  check(typeof client.immediately === 'boolean', 'dsh.client.immediately is a boolean')
  check(Array.isArray(client.inject), 'dsh.client.inject is an array')
  for (const entry of client.inject || []) {
    check(
      typeof entry === 'string' && entry.startsWith('@deepseek-ai/dsh-client-'),
      'dsh.client.inject entries are Harness client package ids',
      String(entry),
    )
  }
  const clientExport = pkg.exports && pkg.exports['./client']
  check(clientExport !== undefined, 'exports declares ./client')
  const clientTypes = clientExport && clientExport.types
  check(
    typeof clientTypes === 'string' && existsSync(join(root, clientTypes)),
    './client types entry exists (a dangling types path breaks consumers)',
    String(clientTypes),
  )
  const clientEntry = clientExport && (clientExport.default || clientExport)
  check(
    typeof clientEntry === 'string' && existsSync(join(root, clientEntry)),
    './client entry exists',
    String(clientEntry),
  )
  if (typeof clientEntry === 'string' && existsSync(join(root, clientEntry))) {
    const artifact = readFileSync(join(root, clientEntry), 'utf8')
    // The browser loader owns module instantiation: the artifact must register
    // itself rather than exporting an ES module.
    check(
      /window\.__ModuleLoader__\.load\(/.test(artifact),
      'client artifact uses window.__ModuleLoader__.load',
    )
    check(
      new RegExp(`id:\\s*['"]${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(artifact),
      'client module id equals the package name',
    )
    check(/factory\s*\(/.test(artifact), 'client artifact declares a factory')
    check(/inject:\s*\[/.test(artifact), 'client module declares inject')
    // Harness Client packages may be declared for activation ordering, but must
    // never be require()d: they change without notice and a plain-JS plugin has
    // no type check, and a throwing component blanks the slot entry.
    check(
      !/require\(\s*['"]@deepseek-ai\//.test(artifact),
      'client artifact does not require() a Harness Client package',
    )
    const required = [...artifact.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    const external = new Set(required.filter((id) => !id.startsWith('.')))
    const declaredExternal = new Set(client.external || [])
    for (const id of external) {
      check(
        id === 'react' || declaredExternal.has(id),
        `client external '${id}' is react or declared in dsh.client.external`,
        id,
      )
    }
  }
}

// --- files that must ship ---------------------------------------------------
for (const required of ['README.md', 'LICENSE']) {
  check(existsSync(join(root, required)), `${required} exists`)
}
const files = pkg.files || []
check(files.includes('lib'), 'files[] ships lib')
check(files.includes('cordis.patch.yml'), 'files[] ships cordis.patch.yml')

// --- dependency discipline --------------------------------------------------
// A community plugin must not depend on harness-internal packages: they are not
// resolvable from a profile's node_modules and would break on upgrade.
const runtime = Object.keys(pkg.dependencies || {})
const internal = runtime.filter((dep) => /^@deepseek-ai\/(?!cordis$|schemastery$)/.test(dep))
check(internal.length === 0, 'no harness-internal runtime dependencies', internal.join(', ') || 'none')

console.log('dsh-relayhub-bridge packaging check')
console.log(notes.join('\n'))
if (failures.length > 0) {
  console.error(failures.join('\n'))
  console.error(`\n${failures.length} check(s) failed.`)
  process.exit(1)
}
console.log(`\nall ${notes.length} checks passed.`)
