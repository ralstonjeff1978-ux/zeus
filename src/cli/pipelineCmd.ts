import { loadRegistry } from '../registry/registry.ts'
import { pipeline, PIPELINES, type Stage } from '../swarm/pipeline.ts'
import { C } from './style.ts'

/** `zeus pipe` — run brains in series, each working on the last one's output. */

export async function cmdPipeline(
  name: string | undefined,
  goal: string,
  opts: { brains?: string[]; keepGoing?: boolean; showAll?: boolean },
): Promise<number> {
  if (!name || name === 'list') {
    console.log(C.bold('\nPipelines\n'))
    for (const [id, p] of Object.entries(PIPELINES)) {
      console.log(`  ${C.cyan(id.padEnd(10))} ${C.dim(p.describe)}`)
      console.log(`  ${' '.repeat(10)} ${C.grey(p.stages.map(s => s.name).join(' → '))}\n`)
    }
    console.log(C.dim('  zeus pipe <name> <goal...>\n'))
    return name === 'list' ? 0 : 2
  }

  const chosen = PIPELINES[name]
  if (!chosen) {
    console.error(
      C.red(`Unknown pipeline "${name}".`) +
        ` Available: ${Object.keys(PIPELINES).join(', ')}. Run ${C.cyan('zeus pipe list')}.`,
    )
    return 2
  }
  if (!goal.trim()) {
    console.error(`Usage: zeus pipe ${name} <goal...>`)
    return 2
  }

  const reg = await loadRegistry()

  // --brains overrides role selection positionally, for when the user wants a
  // specific brain on a specific stage rather than whatever the roles resolve to.
  let stages: Stage[] = chosen.stages
  if (opts.brains?.length) {
    stages = chosen.stages.map((s, i) => ({ ...s, brain: opts.brains![i] ?? opts.brains![opts.brains!.length - 1] }))
  }

  const started = performance.now()
  const res = await pipeline(goal, stages, {
    registry: reg,
    context: `zeus pipe ${name}`,
    stopOnError: !opts.keepGoing,
    onStage: (stageName, brainId, i, total) => {
      process.stderr.write(
        `${C.dim(`[${i + 1}/${total}]`)} ${C.cyan(stageName.padEnd(12))} ${C.dim(brainId)}\n`,
      )
    },
  })

  for (const o of res.outputs) {
    const mark = o.skipped ? C.dim('–') : o.error ? C.red('✗') : C.green('✓')
    const note = o.skipped
      ? C.dim('skipped')
      : o.error
        ? C.red(o.error.slice(0, 70))
        : C.dim(`${o.ms}ms · ${o.text.length} chars`)
    console.error(`${mark} ${o.name.padEnd(12)} ${note}`)
  }

  // Intermediate stages are shown on stderr so `zeus pipe ... > out.md` still
  // captures only the finished work.
  if (opts.showAll) {
    for (const o of res.outputs) {
      if (o.skipped || !o.text.trim()) continue
      console.error(`\n${C.dim(`── ${o.name} (${o.brainId})`)}\n`)
      console.error(o.text)
    }
  }

  if (!res.final) {
    console.error(C.red(`\nThe pipeline produced nothing${res.failedAt ? ` — it failed at "${res.failedAt}"` : ''}.`))
    return 1
  }

  console.log(`\n${res.final}`)

  const secs = ((performance.now() - started) / 1000).toFixed(1)
  const cost = res.totalCostUsd ? ` · $${res.totalCostUsd.toFixed(4)}` : ''
  console.error(C.dim(`\n${res.outputs.filter(o => !o.skipped && !o.error).length} stages · ${secs}s${cost}`))
  if (res.failedAt) {
    console.error(C.yellow(`Stage "${res.failedAt}" failed; the output above is from the last stage that worked.`))
    return 1
  }
  return 0
}
