#!/usr/bin/env bun
/**
 * Assign routing roles across the registry.
 *
 * Roles are what the recipes route by, and the adversarial review step only
 * works if the reviewer is a different brain from the author. This picks
 * distinct brains per role, preferring ones that fit entirely in VRAM — a model
 * that spills to system RAM is too slow to sit in an agent loop.
 *
 * Re-run after `zeus discover --save` picks up new models.
 */
import { loadRegistry, saveRegistry } from '../src/registry/registry.ts'
import type { Brain } from '../src/registry/schema.ts'

const VRAM_GB = Number(process.env.ZEUS_VRAM_GB ?? 24)
const MAX_PARAMS_B = Number(process.env.ZEUS_MAX_PARAMS_B ?? 35)

/** Pull the parameter count out of a model tag, e.g. ":30b" or "-35b". */
function paramsOf(b: Brain): number | undefined {
  const m = /[:\-_](\d+(?:\.\d+)?)b\b/i.exec(b.model)
  return m ? Number(m[1]) : undefined
}

function fitsVram(b: Brain): boolean {
  return b.sizeGb !== undefined && b.sizeGb <= VRAM_GB * 0.9
}

function eligible(b: Brain): boolean {
  if (b.kind !== 'chat' || b.locality !== 'local') return false
  const p = paramsOf(b)
  if (p !== undefined && p > MAX_PARAMS_B) return false
  return fitsVram(b)
}

const reg = await loadRegistry()

// Roles in priority order. Each takes the best unclaimed brain matching its
// preference, so no two roles land on the same brain while alternatives remain.
const ROLES: Array<{ role: string; prefer: RegExp; fallbackAny?: boolean }> = [
  { role: 'coder', prefer: /coder|code/i },
  { role: 'architect', prefer: /glm|llama|gemma|qwen3\.|qwen3-abl/i, fallbackAny: true },
  { role: 'reviewer', prefer: /gemma|glm|qwen/i, fallbackAny: true },
  { role: 'writer', prefer: /gemma|llama|qwen/i, fallbackAny: true },
  { role: 'reasoner', prefer: /r1|reason|think|qwen3\./i, fallbackAny: true },
]

const pool = reg.brains.filter(eligible).sort((a, b) => (b.sizeGb ?? 0) - (a.sizeGb ?? 0))
if (!pool.length) {
  console.error(`No local chat brains fit ${VRAM_GB}GB VRAM at <=${MAX_PARAMS_B}B. Nothing to assign.`)
  process.exit(1)
}

// Clear only the roles this script manages; leave hand-added tags alone.
const MANAGED = new Set([...ROLES.map(r => r.role), 'vision', 'security', 'embed', 'general'])
for (const b of reg.brains) b.roles = b.roles.filter(r => !MANAGED.has(r))

const claimed = new Set<string>()
const assigned: Array<[string, string]> = []

for (const { role, prefer, fallbackAny } of ROLES) {
  let pick = pool.find(b => !claimed.has(b.id) && prefer.test(b.model))
  if (!pick && fallbackAny) pick = pool.find(b => !claimed.has(b.id))
  // Every role must resolve, so once brains run out they are shared rather than
  // left unassigned — a shared reviewer is worse than none, but an unroutable
  // recipe simply fails.
  if (!pick) pick = pool.find(b => prefer.test(b.model)) ?? pool[0]
  if (!pick) continue

  pick.roles = [...new Set([...pick.roles, role])]
  claimed.add(pick.id)
  assigned.push([role, pick.id])
}

// Capability roles are properties of the model, not scheduling choices.
for (const b of reg.brains) {
  if (b.kind === 'embed') b.roles = [...new Set([...b.roles, 'embed'])]
  if (/-vl|vision|llava/i.test(b.model)) b.roles = [...new Set([...b.roles, 'vision'])]
  if (/sec|security/i.test(b.model)) b.roles = [...new Set([...b.roles, 'security'])]
  if (!b.roles.length) b.roles = ['general']
}

const coder = reg.brains.find(b => b.roles.includes('coder'))
if (coder) reg.default = coder.id

await saveRegistry(reg)

console.log(`Assigned roles (<=${MAX_PARAMS_B}B, fits ${VRAM_GB}GB VRAM):\n`)
for (const [role, id] of assigned) {
  const b = reg.brains.find(x => x.id === id)!
  console.log(`  ${role.padEnd(10)} ${id.padEnd(44)} ${b.sizeGb ?? '?'}GB`)
}
for (const extra of ['vision', 'security', 'embed']) {
  for (const b of reg.brains.filter(x => x.roles.includes(extra))) {
    console.log(`  ${extra.padEnd(10)} ${b.id.padEnd(44)} ${b.sizeGb ?? '?'}GB`)
  }
}
console.log(`\n  default    ${reg.default}`)

const distinct = new Set(assigned.map(a => a[1])).size
if (distinct < assigned.length) {
  console.log(
    `\nNote: only ${distinct} distinct brains cover ${assigned.length} roles. ` +
      `Adversarial review is weaker when the reviewer is also the author — pull another model to fix this.`,
  )
}
