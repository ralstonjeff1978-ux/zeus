import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RegistryFile } from '../registry/schema.ts'
import { routeText, type RouteTarget } from '../core/router.ts'
import * as store from './store.ts'
import type { Job, Step } from './store.ts'
import { runCheck, coerceCheck, type AcceptanceCheck } from './acceptance.ts'

/**
 * The job engine.
 *
 * Long work is not one long conversation — no context window survives it. A job
 * is a tree of small steps, each of which fits comfortably in a brain's window,
 * with its results written to disk as they complete. The engine walks that tree,
 * and can be stopped and resumed at any point.
 *
 * The engine knows nothing about circuits or manuscripts. A recipe supplies the
 * step kinds and their prompts; the engine supplies durability, routing,
 * critique, revision and accounting.
 */

export type StepContext = {
  job: Job
  step: Step
  /** Job-wide accumulated state, parsed from the job record. */
  state: Record<string, unknown>
  registry: RegistryFile
  /** Ask a brain something. Routing and failover are handled for you. */
  think: (opts: {
    prompt: string
    system?: string
    role?: string
    brain?: string
    maxTokens?: number
  }) => Promise<{ text: string; brainId?: string; costUsd: number }>
  /** Everything already produced by earlier steps, newest last. */
  priorOutputs: (kind?: string) => string[]
  workdir: string
}

/** A step to append: the shape recipes use for both seeding and spawning. */
export type StepSpec = {
  kind: string
  title: string
  input?: unknown
  ord?: number
  /** Optional acceptance gate persisted on the step; the engine runs it after the handler. */
  acceptance?: AcceptanceCheck
}

export type StepHandler = (ctx: StepContext) => Promise<{
  output: string
  /** Steps to append as a result of this one — how a plan expands into work. */
  spawn?: StepSpec[]
  /** Merged into the job's durable state. */
  patchState?: Record<string, unknown>
  /**
   * An acceptance gate to run against what this step just produced. The step is
   * marked `done` only if it passes; otherwise it takes the ordinary retry/resume
   * path. A handler that has just written code returns the command that verifies
   * it here. Takes precedence over any gate persisted on the step. One check, a
   * list (all must pass), or nothing.
   */
  accept?: AcceptanceCheck | AcceptanceCheck[] | null
}>

export type Recipe = {
  kind: string
  description: string
  /** Steps created when the job is started. */
  seed: (goal: string) => StepSpec[]
  handlers: Record<string, StepHandler>
}

const recipes = new Map<string, Recipe>()

export function registerRecipe(r: Recipe): void {
  recipes.set(r.kind, r)
}

export function getRecipe(kind: string): Recipe {
  const r = recipes.get(kind)
  if (!r) {
    throw new Error(`No recipe named "${kind}". Known: ${[...recipes.keys()].join(', ') || 'none'}`)
  }
  return r
}

export function recipeNames(): string[] {
  return [...recipes.keys()]
}

export type StartOptions = {
  kind: string
  title: string
  goal: string
  workdir: string
  state?: Record<string, unknown>
}

export function startJob(opts: StartOptions): Job {
  const recipe = getRecipe(opts.kind)
  const id = `${opts.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const workdir = resolve(opts.workdir)
  mkdirSync(workdir, { recursive: true })

  const job = store.createJob({
    id,
    kind: opts.kind,
    title: opts.title,
    goal: opts.goal,
    state: JSON.stringify(opts.state ?? {}),
    workdir,
  })

  let ord = 0
  for (const s of recipe.seed(opts.goal)) {
    store.addStep({
      jobId: id,
      kind: s.kind,
      title: s.title,
      input: s.input,
      ord: s.ord ?? ord++,
      acceptance: s.acceptance,
    })
  }
  return job
}

export type RunEvent =
  | { type: 'step_start'; step: Step }
  | { type: 'step_done'; step: Step; output: string; costUsd: number; brainId?: string }
  | { type: 'step_failed'; step: Step; error: string }
  /** An acceptance gate ran for a step; `passed` decides whether it may be `done`. */
  | { type: 'gate'; step: Step; passed: boolean; evidence: string }
  | { type: 'spawned'; count: number }
  | { type: 'job_done'; jobId: string; costUsd: number }
  | { type: 'job_paused'; jobId: string; reason: string }

/** Thrown internally when an acceptance gate fails, so the step's existing
 *  retry/resume path handles it exactly like any other step failure. */
class GateFailure extends Error {}

export type RunOptions = {
  registry: RegistryFile
  /** Default brain when a step does not request a role. */
  defaultBrain?: string
  /** Stop after this many steps; the job stays resumable. */
  maxSteps?: number
  maxCostUsd?: number
  /** Attempts per step before it is marked failed. */
  maxAttempts?: number
  signal?: AbortSignal
}

export async function* runJob(jobId: string, opts: RunOptions): AsyncGenerator<RunEvent, void, void> {
  const job = store.getJob(jobId)
  if (!job) throw new Error(`No job "${jobId}".`)
  const recipe = getRecipe(job.kind)

  store.reclaimRunning(jobId)

  let executed = 0
  const maxSteps = opts.maxSteps ?? Number.MAX_SAFE_INTEGER
  const maxAttempts = opts.maxAttempts ?? 2
  let spent = store.progress(jobId).costUsd

  while (executed < maxSteps) {
    if (opts.signal?.aborted) {
      yield { type: 'job_paused', jobId, reason: 'stopped' }
      return
    }
    if (opts.maxCostUsd !== undefined && spent >= opts.maxCostUsd) {
      store.updateJob(jobId, { status: 'paused' })
      yield { type: 'job_paused', jobId, reason: `budget of $${opts.maxCostUsd} reached` }
      return
    }

    const step = store.nextPending(jobId)
    if (!step) break

    const handler = recipe.handlers[step.kind]
    if (!handler) {
      store.updateStep(step.id, { status: 'failed', error: `no handler for step kind "${step.kind}"` })
      yield { type: 'step_failed', step, error: `no handler for step kind "${step.kind}"` }
      continue
    }

    store.updateStep(step.id, { status: 'running', bumpAttempts: true })
    yield { type: 'step_start', step }

    const current = store.getJob(jobId)!
    const state = JSON.parse(current.state || '{}') as Record<string, unknown>
    let stepCost = 0
    let lastBrain: string | undefined

    const ctx: StepContext = {
      job: current,
      step,
      state,
      registry: opts.registry,
      workdir: current.workdir,
      priorOutputs: kind =>
        store
          .steps(jobId)
          .filter(s => s.status === 'done' && s.output && (!kind || s.kind === kind))
          .map(s => s.output!),
      think: async t => {
        const target: RouteTarget = t.brain
          ? { by: 'id', id: t.brain }
          : t.role
            ? { by: 'role', role: t.role }
            : { by: 'id', id: opts.defaultBrain ?? opts.registry.default ?? '' }

        const res = await routeText(
          opts.registry,
          target,
          {
            system: t.system,
            messages: [{ role: 'user', content: [{ type: 'text', text: t.prompt }] }],
            maxTokens: t.maxTokens ?? 8192,
          },
          { context: `job:${jobId}:${step.kind}`, signal: opts.signal, retries: 2 },
        )
        const cost = res.usage.costUsd ?? 0
        stepCost += cost
        spent += cost
        lastBrain = res.brainId
        return { text: res.text, brainId: res.brainId, costUsd: cost }
      },
    }

    try {
      const result = await handler(ctx)

      // Acceptance gate — "run what it wrote". A step that produced code or
      // artifacts is not done until something verified it. The gate runs BEFORE
      // any spawn/patchState is persisted, so a failed gate leaves no partial
      // side effects in the job tree: the step re-runs from clean on resume.
      const check = coerceCheck(result.accept) ?? persistedCheck(step)
      if (check) {
        const gate = await runCheck(check, { cwd: current.workdir, signal: opts.signal })
        yield { type: 'gate', step, passed: gate.passed, evidence: gate.evidence }
        if (!gate.passed) throw new GateFailure(gate.evidence)
      }

      if (result.patchState) {
        store.updateJob(jobId, { state: JSON.stringify({ ...state, ...result.patchState }) })
      }

      let spawned = 0
      if (result.spawn?.length) {
        const existing = store.steps(jobId)
        let ord = Math.max(step.ord, ...existing.map(s => s.ord)) + 1
        for (const s of result.spawn) {
          store.addStep({
            jobId,
            parentId: step.id,
            kind: s.kind,
            title: s.title,
            input: s.input,
            ord: s.ord ?? ord++,
            acceptance: s.acceptance,
          })
          spawned++
        }
      }

      store.updateStep(step.id, {
        status: 'done',
        output: result.output,
        costUsd: stepCost,
        brainId: lastBrain ?? null,
        error: null,
      })
      yield {
        type: 'step_done',
        step,
        output: result.output,
        costUsd: stepCost,
        brainId: lastBrain,
      }
      if (spawned) yield { type: 'spawned', count: spawned }
    } catch (e) {
      const message =
        e instanceof GateFailure ? `Acceptance gate failed:\n${e.message}` : (e as Error).message
      const fresh = store.stepById(step.id)!
      if (fresh.attempts >= maxAttempts) {
        store.updateStep(step.id, { status: 'failed', error: message, costUsd: stepCost })
        yield { type: 'step_failed', step, error: message }
      } else {
        // Leave it pending so the next pass retries it.
        store.updateStep(step.id, { status: 'pending', error: message, costUsd: stepCost })
        yield { type: 'step_failed', step, error: `${message} (will retry)` }
      }
    }

    executed++
  }

  const p = store.progress(jobId)
  if (!store.nextPending(jobId)) {
    store.updateJob(jobId, { status: p.failed > 0 ? 'failed' : 'done' })
    yield { type: 'job_done', jobId, costUsd: p.costUsd }
  } else {
    store.updateJob(jobId, { status: 'paused' })
    yield { type: 'job_paused', jobId, reason: `step limit of ${maxSteps} reached` }
  }
}

/** The acceptance gate persisted on a step at creation time, if any and valid. */
function persistedCheck(step: Step): AcceptanceCheck | undefined {
  if (!step.acceptance) return undefined
  try {
    return JSON.parse(step.acceptance) as AcceptanceCheck
  } catch {
    // A malformed stored check should not crash the run; treat it as no gate.
    return undefined
  }
}

export { store }
