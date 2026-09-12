import { loadRegistry } from '../registry/registry.ts'
import { candidateBrains, candidateNote } from '../registry/candidates.ts'
import { tournament, consensus } from '../swarm/tournament.ts'
import { C } from './style.ts'

/** Swarm commands: tournament and consensus across several brains. */

export async function cmdSwarm(
  prompt: string,
  opts: { brains?: string[]; judge?: string; consensusOnly?: boolean },
): Promise<number> {
  const reg = await loadRegistry()

  let contestants = opts.brains
  if (!contestants?.length) {
    const picked = candidateBrains(reg, { exclude: opts.judge ? [opts.judge] : [], limit: 3 })
    contestants = picked.map(b => b.id)
    if (contestants.length) {
      console.error(C.dim(`Using ${contestants.join(', ')} — pass --brains to choose.`))
      const note = candidateNote(picked)
      if (note) console.error(C.dim(note))
    }
  }

  if (contestants.length < 2) {
    console.error(
      C.red('A swarm needs at least two chat brains in the registry.') +
        `\nAdd another to ${C.cyan('brains.yaml')}, or pass --brains a,b.`,
    )
    return 2
  }

  if (opts.consensusOnly) {
    const res = await consensus(prompt, { registry: reg, contestants, context: 'zeus consensus' })
    for (const a of res.answers) {
      console.log(`\n${C.bold(`── ${a.brainId}`)} ${C.dim(a.error ? 'failed' : `${a.ms}ms`)}`)
      console.log(a.error ? C.red(a.error) : a.text)
    }
    if (res.totalCostUsd) console.error(C.dim(`\n$${res.totalCostUsd.toFixed(4)}`))
    console.error(
      C.dim('\nThese are independent answers. Where they disagree is where a human should look.'),
    )
    return 0
  }

  const res = await tournament(prompt, {
    registry: reg,
    contestants,
    judge: opts.judge,
    judgeRole: 'reviewer',
    context: 'zeus swarm',
  })

  for (const c of res.contestants) {
    const mark = c.error ? C.red('✗') : c === res.winner ? C.green('★') : C.dim('·')
    console.error(`${mark} ${c.brainId.padEnd(40)} ${C.dim(c.error ? c.error.slice(0, 60) : `${c.ms}ms`)}`)
  }

  if (res.verdict) {
    console.error(`\n${C.dim('── verdict' + (res.judgeBrainId ? ` (${res.judgeBrainId})` : ''))}`)
    console.error(C.dim(res.verdict))
  }

  if (!res.winner) {
    console.error(C.red('\nNo answer was produced.'))
    return 1
  }

  console.log(`\n${res.winner.text}`)
  if (res.totalCostUsd) console.error(C.dim(`\n$${res.totalCostUsd.toFixed(4)} across ${res.contestants.length} brains`))
  return 0
}
