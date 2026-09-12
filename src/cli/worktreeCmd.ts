import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { loadRegistry } from '../registry/registry.ts'
import { candidateBrains, candidateNote } from '../registry/candidates.ts'
import { worktreeSwarm, adopt, cleanup, type Attempt } from '../swarm/worktree.ts'
import { C } from './style.ts'

/**
 * `zeus race` — several brains attempt the same code change in isolated git
 * worktrees; the diffs are compared and you choose what to keep.
 */

export async function cmdRace(
  task: string,
  opts: {
    brains?: string[]
    judge?: string
    dir?: string
    verify?: string
    maxTurns?: number
    budget?: number
    tools?: string
    keep?: boolean
    yes?: boolean
  },
): Promise<number> {
  const reg = await loadRegistry()
  const repo = resolve(opts.dir ?? process.cwd())

  let brains = opts.brains
  if (!brains?.length) {
    // Brains without native tool calling are deliberately still eligible: the
    // shim renders tools into the prompt, so they can edit files perfectly well.
    const picked = candidateBrains(reg, {
      exclude: opts.judge ? [opts.judge] : [],
      limit: 3,
      preferRole: 'coder',
    })
    brains = picked.map(b => b.id)
    if (brains.length) {
      console.error(C.dim(`Racing ${brains.join(', ')} — pass --brains to choose.`))
      const note = candidateNote(picked)
      if (note) console.error(C.dim(note))
    }
  }

  if (!brains.length) {
    console.error(
      C.red('No chat brain in the registry to race.') + `\nAdd one to ${C.cyan('brains.yaml')}, or pass --brains a,b.`,
    )
    return 2
  }

  const ctl = new AbortController()
  const onSigint = () => {
    console.error(C.dim('\n(stopping…)'))
    ctl.abort()
  }
  process.on('SIGINT', onSigint)

  console.error(C.dim(`\nEach brain gets its own checkout of ${repo}. Your working tree is untouched.\n`))

  let result
  try {
    result = await worktreeSwarm(task, {
      registry: reg,
      brains,
      repo,
      judge: opts.judge,
      verifyCmd: opts.verify,
      maxTurns: opts.maxTurns,
      maxCostUsd: opts.budget,
      toolSet: opts.tools,
      signal: ctl.signal,
      onEvent: (brainId, event, detail) => {
        if (event === 'start') console.error(`${C.cyan('▸')} ${brainId} ${C.dim('started')}`)
        else if (event === 'verify') console.error(`${C.dim('  …verifying')} ${brainId}`)
        else if (event === 'done') console.error(`${C.green('✓')} ${brainId} ${C.dim(detail ?? '')}`)
      },
    })
  } catch (e) {
    process.off('SIGINT', onSigint)
    console.error(C.red((e as Error).message))
    return 1
  } finally {
    process.off('SIGINT', onSigint)
  }

  console.error(`\n${C.bold('Attempts')}`)
  for (const a of result.attempts) {
    const mark = a.error ? C.red('✗') : a === result.winner ? C.green('★') : C.dim('·')
    const stat = a.error
      ? C.red(a.error.slice(0, 60))
      : `${a.filesChanged} files ${C.green('+' + a.insertions)}/${C.red('-' + a.deletions)}` +
        ` ${C.dim(`${a.turns} turns · ${(a.ms / 1000).toFixed(0)}s`)}` +
        (a.verify ? (a.verify.ok ? C.green(' · verified') : C.red(' · verify FAILED')) : '')
    console.error(`${mark} ${a.brainId.padEnd(38)} ${stat}`)
  }

  if (result.verdict) {
    console.error(`\n${C.dim('── verdict' + (result.judgeBrainId ? ` (${result.judgeBrainId})` : ''))}`)
    console.error(C.dim(result.verdict))
  }

  if (!result.winner) {
    console.error(C.red('\nNothing to adopt.'))
    if (!opts.keep) await cleanup(repo, result)
    return 1
  }

  const w = result.winner
  console.error(`\n${C.bold('Winner:')} ${C.green(w.brainId)}`)
  if (w.summary) console.error(C.dim(w.summary))
  console.log(w.diff)

  if (result.totalCostUsd) {
    console.error(C.dim(`\n$${result.totalCostUsd.toFixed(4)} across ${result.attempts.length} attempts`))
  }

  const shouldAdopt = opts.yes ? true : await confirmAdopt(w)
  if (shouldAdopt) {
    try {
      await adopt(repo, w)
      console.error(C.green(`\nApplied to ${repo} as uncommitted changes. Nothing was committed.`))
    } catch (e) {
      console.error(C.red(`\n${(e as Error).message}`))
      console.error(C.dim(`The attempt is still on branch ${w.branch} at ${w.dir}`))
      return 1
    }
  } else {
    console.error(C.dim('\nNot applied.'))
  }

  if (opts.keep) {
    console.error(C.dim(`Worktrees kept at ${result.root}`))
    for (const a of result.attempts) {
      if (!a.error) console.error(C.dim(`  ${a.brainId.padEnd(38)} ${a.dir}`))
    }
    console.error(C.dim('Remove them with: git worktree remove --force <path>'))
  } else {
    await cleanup(repo, result)
  }

  return 0
}

async function confirmAdopt(w: Attempt): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const a = (await rl.question(`${C.bold('Apply this diff to your working tree?')} [y/N] `))
      .trim()
      .toLowerCase()
    return a === 'y' || a === 'yes'
  } finally {
    rl.close()
  }
}
