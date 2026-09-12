import { resolve, join } from 'node:path'
import { loadRegistry } from '../registry/registry.ts'
import { startJob, runJob, recipeNames, getRecipe, store } from '../jobs/engine.ts'
import { C, bar } from './style.ts'
import { str, num, type Parsed } from './args.ts'

/** Job commands: long, resumable work. */

// Recipes register themselves on import.
import '../jobs/recipes/design.ts'
import '../jobs/recipes/book.ts'
import '../jobs/recipes/research.ts'

export async function cmdJob(rest: string[], p: Parsed): Promise<number> {
  const sub = rest[0]

  switch (sub) {
    case 'start': {
      const kind = rest[1]
      const goal = rest.slice(2).join(' ')
      if (!kind || !goal) {
        console.error(`Usage: zeus job start <recipe> <goal...>\nRecipes: ${recipeNames().join(', ')}`)
        return 2
      }
      try {
        getRecipe(kind)
      } catch (e) {
        console.error(C.red((e as Error).message))
        return 2
      }

      const title = str(p, 'title') ?? goal.slice(0, 70)
      const dir = str(p, 'dir') ?? join(process.cwd(), 'zeus-jobs')
      let state: Record<string, unknown> = {}
      const stateArg = str(p, 'state')
      if (stateArg) {
        try {
          state = JSON.parse(stateArg)
        } catch {
          console.error(C.red('--state must be valid JSON.'))
          return 2
        }
      }

      const job = startJob({ kind, title, goal, workdir: resolve(dir, `${kind}-${Date.now().toString(36)}`), state })
      console.log(`${C.green('Started')} ${C.bold(job.id)}`)
      console.log(`  ${job.title}`)
      console.log(`  workdir  ${job.workdir}`)
      console.log(`\nRun it with:  ${C.cyan(`zeus job run ${job.id}`)}`)
      return 0
    }

    case 'run': {
      const id = rest[1]
      if (!id) {
        console.error('Usage: zeus job run <id>')
        return 2
      }
      const reg = await loadRegistry()
      const ctl = new AbortController()
      const onSigint = () => {
        console.log(C.dim('\n(stopping after this step — the job stays resumable)'))
        ctl.abort()
      }
      process.on('SIGINT', onSigint)

      let failed = 0
      try {
        for await (const ev of runJob(id, {
          registry: reg,
          defaultBrain: str(p, 'brain'),
          maxSteps: num(p, 'steps'),
          maxCostUsd: num(p, 'budget'),
          signal: ctl.signal,
        })) {
          switch (ev.type) {
            case 'step_start':
              process.stdout.write(`${C.dim('▸')} ${ev.step.title.padEnd(46)} `)
              break
            case 'step_done': {
              const cost = ev.costUsd ? ` $${ev.costUsd.toFixed(4)}` : ''
              console.log(`${C.green('done')}${C.dim(`${ev.brainId ? ` · ${ev.brainId}` : ''}${cost}`)}`)
              break
            }
            case 'gate':
              // Runs between step_start and its resolution; a passing gate shows
              // a small marker before the `done` word, a failing one is reported
              // by the step_failed that follows it.
              if (ev.passed) process.stdout.write(C.dim('gate✓ '))
              break
            case 'step_failed':
              failed++
              console.log(C.red(`failed — ${ev.error.slice(0, 100)}`))
              break
            case 'spawned':
              console.log(C.dim(`  + ${ev.count} steps queued`))
              break
            case 'job_done': {
              const pr = store.progress(id)
              console.log(
                `\n${C.green('Job complete')} — ${pr.done}/${pr.total} steps` +
                  (pr.costUsd ? `, $${pr.costUsd.toFixed(4)}` : ''),
              )
              const j = store.getJob(id)
              if (j) console.log(C.dim(`Output in ${j.workdir}`))
              break
            }
            case 'job_paused':
              console.log(`\n${C.yellow(`Paused — ${ev.reason}`)}`)
              console.log(C.dim(`Resume with: zeus job run ${id}`))
              break
          }
        }
      } finally {
        process.off('SIGINT', onSigint)
      }
      return failed ? 1 : 0
    }

    case 'list': {
      const jobs = store.listJobs()
      if (!jobs.length) {
        console.log(`No jobs. Start one with ${C.cyan('zeus job start design "..."')}`)
        return 0
      }
      for (const j of jobs) {
        const pr = store.progress(j.id)
        const frac = pr.total ? pr.done / pr.total : 0
        const colour = j.status === 'done' ? C.green : j.status === 'failed' ? C.red : C.yellow
        console.log(
          `${colour(j.status.padEnd(7))} ${j.id.padEnd(26)} ${bar(frac, 16)} ${String(pr.done).padStart(3)}/${String(pr.total).padEnd(3)}` +
            (pr.costUsd ? C.dim(` $${pr.costUsd.toFixed(3)}`) : ''),
        )
        console.log(`        ${C.dim(j.title.slice(0, 90))}`)
      }
      return 0
    }

    case 'show': {
      const id = rest[1]
      if (!id) {
        console.error('Usage: zeus job show <id>')
        return 2
      }
      const job = store.getJob(id)
      if (!job) {
        console.error(C.red(`No job "${id}".`))
        return 1
      }
      console.log(`${C.bold(job.title)}\n${C.dim(job.goal)}\n${C.dim(job.workdir)}\n`)
      for (const s of store.steps(id)) {
        const mark =
          s.status === 'done'
            ? C.green('✓')
            : s.status === 'failed'
              ? C.red('✗')
              : s.status === 'running'
                ? C.yellow('…')
                : C.dim('·')
        console.log(
          `${mark} ${String(s.ord).padStart(4)} ${s.kind.padEnd(12)} ${s.title.slice(0, 60).padEnd(60)}` +
            C.dim(`${s.brainId ? ` ${s.brainId}` : ''}${s.costUsd ? ` $${s.costUsd.toFixed(4)}` : ''}`),
        )
        if (s.error) console.log(C.red(`       ${s.error.slice(0, 120)}`))
      }
      return 0
    }

    case 'improve': {
      const id = rest[1]
      if (!id) {
        console.error('Usage: zeus job improve <id>')
        return 2
      }
      const job = store.getJob(id)
      if (!job) {
        console.error(C.red(`No job "${id}".`))
        return 1
      }
      if (job.kind !== 'design') {
        console.error(C.red(`"improve" applies to design jobs; "${id}" is a ${job.kind} job.`))
        return 2
      }
      const { queueImprovementPass } = await import('../jobs/recipes/design.ts')
      const n = queueImprovementPass(id, store)
      store.updateJob(id, { status: 'active' })
      console.log(`${C.green(`Queued ${n} steps`)} — another adversarial review and revision.`)
      console.log(`Run with: ${C.cyan(`zeus job run ${id}`)}`)
      return 0
    }

    default:
      console.error(
        `Usage: zeus job <start|run|list|show|improve>\nRecipes: ${recipeNames().join(', ')}`,
      )
      return 2
  }
}
