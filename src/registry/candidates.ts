import type { Brain, RegistryFile } from './schema.ts'

/**
 * Choosing brains for a multi-brain run, when nobody said which ones.
 *
 * The rule that seems obvious — "use the brains that probed successfully" — is
 * wrong, and wrong in a way that quietly ruins the result. A registry is mostly
 * `untested` right up until someone runs `zeus test --all`, and it returns to
 * mostly `untested` the moment the user swaps their models. Requiring
 * `reachable === true` in that state selects from the handful of small models
 * that happened to be probed, and silently excludes every large one — so the
 * swarm races the toys and reports the winner with a straight face.
 *
 * A failed probe is also not proof of anything durable. Probes fail because a
 * cold model exceeded its load window, or because the GPU was busy with another
 * job at that moment. Recording that is useful; treating it as permanent
 * disqualification is not.
 *
 * So: never exclude, only rank. Probed-good first, untested next, known-failed
 * last but still eligible if nothing better exists. The caller always gets its
 * best available option rather than an empty list and a confusing error.
 */

export type CandidateOptions = {
  kind?: Brain['kind']
  /** Brain ids to leave out — typically the judge, or brains already chosen. */
  exclude?: Iterable<string>
  /** Cap the result. */
  limit?: number
  /** Prefer brains carrying this role, without restricting to them. */
  preferRole?: string
  /**
   * Drop brains whose probe explicitly said they cannot call tools. Only set
   * this where the shim genuinely cannot help, which is rare — the shim exists
   * so that tool-less brains still work.
   */
  requireToolCalls?: boolean
}

/** Higher is better. Probe status dominates; size breaks the tie. */
function rank(b: Brain, preferRole?: string): number {
  let score = 0

  if (b.probed?.reachable === true) score += 1000
  else if (b.probed === undefined) score += 500 // untested — unknown, not bad
  // reachable === false adds nothing, but is not disqualifying.

  if (b.probed?.toolCalls === true) score += 120
  if (preferRole && b.roles.includes(preferRole)) score += 300

  // Among otherwise equal brains, the larger one is the better bet. Remote
  // brains carry no size and are ranked between the mid and large local ones,
  // since a hosted model is generally more capable than a local of any size.
  score += b.locality === 'local' ? Math.min(80, b.sizeGb ?? 0) : 60

  return score
}

export function candidateBrains(reg: RegistryFile, opts: CandidateOptions = {}): Brain[] {
  const excluded = new Set(opts.exclude ?? [])
  const kind = opts.kind ?? 'chat'

  const pool = reg.brains.filter(b => {
    if (b.kind !== kind) return false
    if (excluded.has(b.id)) return false
    if (opts.requireToolCalls && b.probed?.toolCalls === false) return false
    return true
  })

  const sorted = pool.sort((a, b) => rank(b, opts.preferRole) - rank(a, opts.preferRole))

  // The user's declared default goes first when it survived the filters: they
  // chose it, and that outranks anything inferred from a probe.
  if (reg.default) {
    const i = sorted.findIndex(b => b.id === reg.default)
    if (i > 0) sorted.unshift(sorted.splice(i, 1)[0]!)
  }

  return opts.limit ? sorted.slice(0, opts.limit) : sorted
}

/**
 * A one-line note on what was picked and why, so a user staring at an odd
 * lineup can see it was a stale probe rather than a bug.
 */
export function candidateNote(picked: Brain[]): string | undefined {
  const untested = picked.filter(b => b.probed === undefined).length
  const failed = picked.filter(b => b.probed?.reachable === false).length
  if (!untested && !failed) return undefined

  const parts: string[] = []
  if (untested) parts.push(`${untested} never probed`)
  if (failed) parts.push(`${failed} previously failed to respond`)
  return `${parts.join(', ')} — included anyway. Run "zeus test --all" for a better ordering.`
}
