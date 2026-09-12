import type { RegistryFile } from '../registry/schema.ts'
import { routeText, selectBrain, type RouteTarget } from '../core/router.ts'
import type { Usage } from '../adapters/types.ts'

/**
 * Tournament: many brains attempt the same task, a different brain judges.
 *
 * This is the compensating mechanism for running modest local models. A single
 * 30B brain has a certain hit rate; three of them attempting independently and
 * a fourth selecting the best answer has a meaningfully higher one, because the
 * failures are usually uncorrelated while the successes agree.
 *
 * The judge must not be one of the contestants. A brain shown its own work
 * alongside a rival's picks its own, and the whole exercise collapses.
 */

export type Contestant = {
  brainId: string
  text: string
  usage: Usage
  error?: string
  ms: number
}

export type TournamentResult = {
  contestants: Contestant[]
  winner?: Contestant
  /** The judge's reasoning, for the record. */
  verdict?: string
  judgeBrainId?: string
  totalCostUsd: number
}

export type TournamentOptions = {
  registry: RegistryFile
  /** Brain ids that will attempt the task. */
  contestants: string[]
  /** Brain id that picks the winner. Must not be a contestant. */
  judge?: string
  /** Role to draw a judge from when none is named. */
  judgeRole?: string
  system?: string
  maxTokens?: number
  signal?: AbortSignal
  context?: string
}

export async function tournament(prompt: string, opts: TournamentOptions): Promise<TournamentResult> {
  if (opts.contestants.length < 2) {
    throw new Error('A tournament needs at least two contestants.')
  }

  const runs = await runContestants(prompt, opts)

  const valid = runs.filter(r => !r.error && r.text.trim())
  let totalCostUsd = runs.reduce((n, r) => n + (r.usage.costUsd ?? 0), 0)

  if (valid.length === 0) {
    return { contestants: runs, totalCostUsd }
  }
  if (valid.length === 1) {
    return { contestants: runs, winner: valid[0], totalCostUsd, verdict: 'Only one entrant produced an answer.' }
  }

  const judgeId = pickJudge(opts, valid.map(v => v.brainId))
  if (!judgeId) {
    // Without an impartial judge, returning the longest answer would be a
    // fabricated result. Report honestly that no selection was made.
    return {
      contestants: runs,
      totalCostUsd,
      verdict:
        'No impartial judge was available — every candidate brain also competed. ' +
        'Register another brain, or pass --judge, to have a winner selected.',
    }
  }

  // Anonymised and shuffled: a judge that can see which brain wrote what will
  // favour the one it recognises as strongest rather than the better answer.
  const shuffled = [...valid].sort(() => Math.random() - 0.5)
  const labelled = shuffled.map((c, i) => ({ label: String.fromCharCode(65 + i), c }))

  const submissions = labelled
    .map(({ label, c }) => `### Answer ${label}\n\n${c.text}`)
    .join('\n\n---\n\n')

  const judgePrompt = `Several people independently attempted this task:

--- TASK ---
${prompt}
--- END TASK ---

Here are their answers.

${submissions}

---

Judge them. Consider correctness first, then completeness, then clarity.
An answer that is confidently wrong is worse than one that admits uncertainty.

Write two or three sentences comparing them, then on the final line write exactly:
WINNER: <letter>`

  let verdict = ''
  let judgeBrainId: string | undefined
  try {
    const res = await routeText(
      opts.registry,
      { by: 'id', id: judgeId },
      {
        system:
          'You are judging work you did not write. Be decisive and specific. ' +
          'Do not reward length. Do not hedge — you must pick one.',
        messages: [{ role: 'user', content: [{ type: 'text', text: judgePrompt }] }],
        maxTokens: 2048,
      },
      { context: `${opts.context ?? 'tournament'}:judge`, signal: opts.signal, retries: 1 },
    )
    verdict = res.text
    judgeBrainId = res.brainId
    totalCostUsd += res.usage.costUsd ?? 0
  } catch (e) {
    return {
      contestants: runs,
      totalCostUsd,
      verdict: `The judge failed: ${(e as Error).message}`,
    }
  }

  const m = /WINNER:\s*([A-Z])/i.exec(verdict)
  const winner = m ? labelled.find(l => l.label === m[1]!.toUpperCase())?.c : undefined

  return {
    contestants: runs,
    winner: winner ?? valid[0],
    verdict,
    judgeBrainId,
    totalCostUsd,
  }
}

/**
 * Run every contestant, parallel across endpoints but sequential within one.
 *
 * Firing several large models at a single local daemon concurrently is
 * counterproductive: they do not fit in VRAM together, so the server evicts and
 * reloads each in turn. Measured on one 24GB card, three concurrent local models
 * took over 150 seconds each and starved the judge entirely. Brains sharing an
 * endpoint are therefore queued; different endpoints still overlap.
 */
async function runContestants(prompt: string, opts: TournamentOptions): Promise<Contestant[]> {
  const groups = new Map<string, string[]>()
  for (const id of opts.contestants) {
    const brain = opts.registry.brains.find(b => b.id === id)
    // Remote brains have no shared local resource, so each is its own lane.
    const lane = brain && brain.locality === 'local' ? brain.endpoint : `remote:${id}`
    const list = groups.get(lane)
    if (list) list.push(id)
    else groups.set(lane, [id])
  }

  const one = async (id: string): Promise<Contestant> => {
    const started = performance.now()
    try {
      const res = await routeText(
        opts.registry,
        { by: 'id', id },
        {
          system: opts.system,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: opts.maxTokens ?? 8192,
        },
        { context: opts.context ?? 'tournament', signal: opts.signal, retries: 1 },
      )
      return { brainId: id, text: res.text, usage: res.usage, ms: Math.round(performance.now() - started) }
    } catch (e) {
      return {
        brainId: id,
        text: '',
        usage: {},
        error: (e as Error).message,
        ms: Math.round(performance.now() - started),
      }
    }
  }

  const lanes = await Promise.all(
    [...groups.values()].map(async ids => {
      const out: Contestant[] = []
      for (const id of ids) out.push(await one(id))
      return out
    }),
  )

  // Restore the caller's ordering so results line up with what was requested.
  const byId = new Map(lanes.flat().map(c => [c.brainId, c]))
  return opts.contestants.map(id => byId.get(id)!).filter(Boolean)
}

function pickJudge(opts: TournamentOptions, competing: string[]): string | undefined {
  if (opts.judge) {
    if (competing.includes(opts.judge)) {
      throw new Error(`Judge "${opts.judge}" is also competing. A brain cannot judge its own work.`)
    }
    return opts.judge
  }

  const busy = new Set(competing)
  if (opts.judgeRole) {
    try {
      const b = selectBrain(opts.registry, { by: 'role', role: opts.judgeRole } as RouteTarget)
      if (!busy.has(b.id)) return b.id
    } catch {
      /* fall through */
    }
  }

  // Prefer a reviewer, then any reachable chat brain that is not competing.
  const candidates = opts.registry.brains.filter(
    b => b.kind === 'chat' && !busy.has(b.id) && b.probed?.reachable !== false,
  )
  const reviewer = candidates.find(b => b.roles.includes('reviewer'))
  return (reviewer ?? candidates[0])?.id
}

/**
 * Consensus: run the same prompt on several brains and report where they agree.
 * Useful for bug hunting, where independent agreement is real signal and
 * disagreement marks exactly the places worth a human's attention.
 */
export async function consensus(
  prompt: string,
  opts: Omit<TournamentOptions, 'judge' | 'judgeRole'>,
): Promise<{ answers: Contestant[]; agreement: string; totalCostUsd: number }> {
  const answers = await runContestants(prompt, opts as TournamentOptions)

  const valid = answers.filter(a => !a.error && a.text.trim())
  const totalCostUsd = answers.reduce((n, a) => n + (a.usage.costUsd ?? 0), 0)
  if (valid.length < 2) {
    return { answers, agreement: 'Not enough answers to compare.', totalCostUsd }
  }

  const merged = valid.map(v => `### ${v.brainId}\n${v.text}`).join('\n\n---\n\n')
  return {
    answers,
    agreement: merged,
    totalCostUsd,
  }
}
