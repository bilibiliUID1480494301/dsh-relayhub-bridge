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
