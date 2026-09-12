import { parse, stringify } from 'yaml'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { RegistryFile, Brain } from './schema.ts'

/**
 * Loading and saving the brain registry.
 *
 * The registry is a plain YAML file the user owns. Zeus reads it, validates it,
 * and writes it back preserving the user's intent. No model is ever hardcoded.
 */

/** Resolution order: $ZEUS_BRAINS, ./brains.yaml, then <zeus-root>/brains.yaml */
export function registryPath(): string {
  const fromEnv = process.env.ZEUS_BRAINS
  if (fromEnv) return resolve(fromEnv)

  const cwdCandidate = resolve(process.cwd(), 'brains.yaml')
  if (existsSync(cwdCandidate)) return cwdCandidate

  // Fall back to the file shipped beside the source tree.
  return resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'brains.yaml')
}

export class RegistryError extends Error {}

export async function loadRegistry(path = registryPath()): Promise<RegistryFile> {
  if (!existsSync(path)) {
    return { version: 1, brains: [] }
  }
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    throw new RegistryError(`Cannot read registry at ${path}: ${(e as Error).message}`)
  }

  let doc: unknown
  try {
    doc = parse(raw)
  } catch (e) {
    throw new RegistryError(`${path} is not valid YAML: ${(e as Error).message}`)
  }

  const result = RegistryFile.safeParse(doc)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new RegistryError(`${path} failed validation:\n${issues}`)
  }

  const ids = new Set<string>()
  for (const b of result.data.brains) {
    if (ids.has(b.id)) throw new RegistryError(`Duplicate brain id "${b.id}" in ${path}`)
    ids.add(b.id)
  }
  if (result.data.default && !ids.has(result.data.default)) {
    throw new RegistryError(`default: "${result.data.default}" does not match any brain id`)
  }

  return result.data
}

/** Write atomically so a crash mid-write can never destroy the user's registry. */
export async function saveRegistry(reg: RegistryFile, path = registryPath()): Promise<void> {
  const check = RegistryFile.safeParse(reg)
  if (!check.success) {
    const issues = check.error.issues
      .map(i => {
        const where = i.path.join('.')
        // Name the offending brain rather than making the user count array indices.
        const m = /^brains\.(\d+)/.exec(where)
        const who = m ? `brain "${reg.brains[Number(m[1])]?.id ?? m[1]}"` : where || '(root)'
        return `  ${who}: ${i.message}${m ? ` (at ${where})` : ''}`
      })
      .join('\n')
    throw new RegistryError(`Refusing to write an invalid registry to ${path}:\n${issues}`)
  }
  const body = stringify(check.data, { lineWidth: 0 })
  const header =
    '# Zeus brain registry.\n' +
    '# Every brain Zeus can reach is declared here. Add one by appending an entry.\n' +
    '# locality is a label for grouping only — Zeus never blocks a remote brain.\n' +
    '# Secrets never live here: use auth: env:YOUR_VAR_NAME\n\n'
  const tmp = join(dirname(path), `.brains.${process.pid}.tmp`)
  await writeFile(tmp, header + body, 'utf8')
  await rename(tmp, path)
}

export function findBrain(reg: RegistryFile, id: string): Brain {
  const hit = reg.brains.find(b => b.id === id)
  if (!hit) {
    const known = reg.brains.map(b => b.id).join(', ') || '(registry is empty)'
    throw new RegistryError(`No brain with id "${id}". Known ids: ${known}`)
  }
  return hit
}

/** Resolve the auth token for a brain, or undefined when it needs none. */
export function resolveAuth(brain: Brain): string | undefined {
  if (brain.auth === 'none') return undefined
  const varName = brain.auth.slice('env:'.length)
  const value = process.env[varName]
  if (!value) {
    throw new RegistryError(
      `Brain "${brain.id}" needs ${varName}, which is not set in the environment.`,
    )
  }
  return value
}
