import type { RegistryFile } from '../registry/schema.ts'
import { routeText, selectBrain } from '../core/router.ts'
import type { Usage } from '../adapters/types.ts'

/**
 * Pipelines: brains in series rather than in parallel.
 *
 * A tournament asks several brains the same question and keeps the best answer.
 * A pipeline asks different brains *different* questions in order, each one
 * working on what the last produced. The two solve different problems: a
 * tournament reduces variance, a pipeline adds stages of thought that no single
 * pass would have produced.
 *
 * The reason this beats one long prompt is division of attention. A brain told
 * to "design it, build it and review it" does all three at once and does the
 * review badly, because it is reviewing a thing it is still in the middle of
 * believing in. Split into stages, the reviewer stage arrives with no stake in
 * the design and finds what the author could not see.
 *
 * Stages are addressed by *role*, never by model name, so a pipeline written
 * today still runs after the whole registry is replaced.
 */

export type Stage = {
  /** Shown to the user; also the key prior output is stored under. */
  name: string
  /** Brain chosen by role. Falls back through `fallbackRoles` then the default. */
  role?: string
  /** An explicit brain id, when the caller really means one brain. */
  brain?: string
  /** Roles to try if `role` matches nothing in this registry. */
  fallbackRoles?: string[]
  system?: string
  maxTokens?: number
  /**
   * Build this stage's prompt. `prior` is the immediately preceding output,
   * `outputs` is everything so far, so a stage can reach further back.
   */
  prompt: (ctx: { goal: string; prior: string; outputs: StageOutput[] }) => string
  /**
   * Optional gate: return false to skip this stage. Used by revision stages
   * that should not run when the review found nothing wrong.
   */
  when?: (ctx: { goal: string; prior: string; outputs: StageOutput[] }) => boolean
}

export type StageOutput = {
  name: string
  brainId: string
  text: string
  usage: Usage
  ms: number
  skipped?: boolean
  error?: string
}

export type PipelineResult = {
  outputs: StageOutput[]
  /** The last stage that actually produced text — the pipeline's answer. */
  final: string
  totalCostUsd: number
  failedAt?: string
}

export type PipelineOptions = {
  registry: RegistryFile
  signal?: AbortSignal
  context?: string
  /** Called as each stage begins, so a CLI can show progress on long runs. */
  onStage?: (name: string, brainId: string, index: number, total: number) => void
  /** Stop the whole pipeline when a stage fails, rather than carrying on. */
  stopOnError?: boolean
}

export async function pipeline(
  goal: string,
  stages: Stage[],
  opts: PipelineOptions,
): Promise<PipelineResult> {
  if (!stages.length) throw new Error('A pipeline needs at least one stage.')

  const outputs: StageOutput[] = []
  let prior = ''
  let totalCostUsd = 0
  let failedAt: string | undefined

  for (const [i, stage] of stages.entries()) {
    if (stage.when && !stage.when({ goal, prior, outputs })) {
      outputs.push({ name: stage.name, brainId: '', text: '', usage: {}, ms: 0, skipped: true })
      continue
    }

    const brainId = resolveStageBrain(opts.registry, stage)
    if (!brainId) {
      outputs.push({
        name: stage.name,
        brainId: '',
        text: '',
        usage: {},
        ms: 0,
        error: `No brain available for stage "${stage.name}"${stage.role ? ` (role: ${stage.role})` : ''}.`,
      })
      failedAt ??= stage.name
      if (opts.stopOnError !== false) break
      continue
    }

    opts.onStage?.(stage.name, brainId, i, stages.length)

    const started = performance.now()
    try {
      const res = await routeText(
        opts.registry,
        { by: 'id', id: brainId },
        {
          system: stage.system,
          messages: [
            { role: 'user', content: [{ type: 'text', text: stage.prompt({ goal, prior, outputs }) }] },
          ],
          maxTokens: stage.maxTokens ?? 8192,
        },
        {
          context: `${opts.context ?? 'pipeline'}:${stage.name}`,
          signal: opts.signal,
          retries: 1,
        },
      )
      const out: StageOutput = {
        name: stage.name,
        // Failover may have served this from a different brain than we asked
        // for; record whoever actually answered.
        brainId: res.brainId ?? brainId,
        text: res.text,
        usage: res.usage,
        ms: Math.round(performance.now() - started),
      }
      outputs.push(out)
      totalCostUsd += res.usage.costUsd ?? 0
      // A stage that returned nothing must not silently become the input to the
      // next one — that turns one failure into a run of empty stages.
      if (res.text.trim()) prior = res.text
      else {
        out.error = 'Returned an empty answer.'
        failedAt ??= stage.name
        if (opts.stopOnError !== false) break
      }
    } catch (e) {
      outputs.push({
        name: stage.name,
        brainId,
        text: '',
        usage: {},
        ms: Math.round(performance.now() - started),
        error: (e as Error).message,
      })
      failedAt ??= stage.name
      if (opts.stopOnError !== false) break
    }
  }

  const produced = outputs.filter(o => !o.error && !o.skipped && o.text.trim())
  return {
    outputs,
    final: produced.length ? produced[produced.length - 1]!.text : '',
    totalCostUsd,
    failedAt,
  }
}

/**
 * Pick the brain for a stage without ever naming a model.
 *
 * Roles are a soft contract: a registry may have no `architect`. Rather than
 * failing the run, walk the declared fallbacks and finally the default brain,
 * so a pipeline is portable across registries of very different sizes.
 */
function resolveStageBrain(reg: RegistryFile, stage: Stage): string | undefined {
  if (stage.brain) return stage.brain

  const roles = [stage.role, ...(stage.fallbackRoles ?? [])].filter(Boolean) as string[]
  for (const role of roles) {
    try {
      const b = selectBrain(reg, { by: 'role', role })
      if (b.probed?.reachable !== false) return b.id
    } catch {
      /* try the next role */
    }
  }

  if (reg.default) {
    const d = reg.brains.find(b => b.id === reg.default)
    if (d && d.probed?.reachable !== false) return d.id
  }
  return reg.brains.find(b => b.kind === 'chat' && b.probed?.reachable !== false)?.id
}

/* ------------------------------------------------------------------ */
/* Built-in pipelines                                                  */
/* ------------------------------------------------------------------ */

const CRITIC_SYSTEM =
  'You are reviewing work you did not write and have no stake in. Find what is ' +
  'actually wrong: errors, omissions, unstated assumptions, things that will not ' +
  'work in practice. Be specific and cite the part you mean. Do not praise. If ' +
  'the work is genuinely sound, say so in one line rather than inventing faults.'

/** Trimmed so an upstream stage cannot crowd out the instructions downstream. */
function clip(s: string, max = 12000): string {
  return s.length > max ? s.slice(0, max) + '\n\n[…truncated]' : s
}

export const PIPELINES: Record<string, { describe: string; stages: Stage[] }> = {
  /** Plan, build, review, revise — the general shape for producing an artifact. */
  build: {
    describe: 'architect plans · coder builds · reviewer critiques · coder revises',
    stages: [
      {
        name: 'plan',
        role: 'architect',
        fallbackRoles: ['reviewer', 'coder'],
        maxTokens: 4096,
        system:
          'You plan work before it is built. Produce a short, concrete plan a ' +
          'competent engineer could follow without asking you anything.',
        prompt: ({ goal }) =>
          `Plan how to accomplish this:\n\n${goal}\n\n` +
          `Give the approach, the parts involved and the order to build them. ` +
          `Note anything genuinely ambiguous and state the assumption you would make. ` +
          `Do not write the final artifact — this is the plan only.`,
      },
      {
        name: 'build',
        role: 'coder',
        fallbackRoles: ['architect'],
        maxTokens: 16384,
        prompt: ({ goal, prior }) =>
          `Task:\n\n${goal}\n\nAn architect produced this plan:\n\n${clip(prior)}\n\n` +
          `Now do the work and produce the complete result. Follow the plan where it is ` +
          `right; depart from it where it is wrong and say briefly why. Output the finished ` +
          `work, not a description of it.`,
      },
      {
        name: 'review',
        role: 'reviewer',
        fallbackRoles: ['architect'],
        maxTokens: 4096,
        system: CRITIC_SYSTEM,
        prompt: ({ goal, prior }) =>
          `This was the task:\n\n${goal}\n\nSomeone produced this:\n\n${clip(prior)}\n\n` +
          `List what is wrong with it, most serious first. If nothing is wrong, reply ` +
          `exactly: NO ISSUES FOUND`,
      },
      {
        name: 'revise',
        role: 'coder',
        fallbackRoles: ['architect'],
        maxTokens: 16384,
        when: ({ prior }) => !/^\s*NO ISSUES FOUND/im.test(prior),
        prompt: ({ goal, outputs }) => {
          const built = outputs.find(o => o.name === 'build')?.text ?? ''
          const review = outputs.find(o => o.name === 'review')?.text ?? ''
          return (
            `Task:\n\n${goal}\n\nYour work:\n\n${clip(built)}\n\n` +
            `A reviewer found these problems:\n\n${clip(review, 6000)}\n\n` +
            `Produce the corrected version in full. Fix what is genuinely wrong. ` +
            `Where the reviewer is mistaken, keep your version and say so in one line ` +
            `at the end. Output the complete corrected work.`
          )
        },
      },
    ],
  },

  /** Research with a second brain checking the claims of the first. */
  research: {
    describe: 'scope · investigate · fact-check by a different brain · synthesise',
    stages: [
      {
        name: 'scope',
        role: 'architect',
        fallbackRoles: ['reviewer'],
        maxTokens: 2048,
        prompt: ({ goal }) =>
          `Break this question into the specific sub-questions that must be answered ` +
          `to answer it properly:\n\n${goal}\n\nList them. Do not answer them yet.`,
      },
      {
        name: 'investigate',
        role: 'researcher',
        fallbackRoles: ['architect', 'coder'],
        maxTokens: 16384,
        prompt: ({ goal, prior }) =>
          `Question:\n\n${goal}\n\nSub-questions to cover:\n\n${clip(prior)}\n\n` +
          `Answer them thoroughly. Where you are uncertain, mark the claim as uncertain ` +
          `rather than stating it flatly.`,
      },
      {
        name: 'fact-check',
        role: 'reviewer',
        fallbackRoles: ['architect'],
        maxTokens: 4096,
        system: CRITIC_SYSTEM,
        prompt: ({ prior }) =>
          `Check these claims:\n\n${clip(prior)}\n\n` +
          `Identify any that are wrong, out of date, unsupported, or stated with more ` +
          `confidence than the evidence allows. Quote the claim, then say what is wrong ` +
          `with it. If all of it holds up, reply exactly: NO ISSUES FOUND`,
      },
      {
        name: 'synthesise',
        role: 'architect',
        fallbackRoles: ['researcher', 'coder'],
        maxTokens: 16384,
        prompt: ({ goal, outputs }) => {
          const found = outputs.find(o => o.name === 'investigate')?.text ?? ''
          const check = outputs.find(o => o.name === 'fact-check')?.text ?? ''
          return (
            `Question:\n\n${goal}\n\nResearch:\n\n${clip(found)}\n\n` +
            `A fact-checker raised:\n\n${clip(check, 6000)}\n\n` +
            `Write the final answer, correcting anything the fact-checker was right about. ` +
            `State remaining uncertainty plainly rather than writing around it.`
          )
        },
      },
    ],
  },

  /** Adversarial analysis — for bug hunting and design review. */
  critique: {
    describe: 'analyse · attack the analysis · final judgement',
    stages: [
      {
        name: 'analyse',
        role: 'reviewer',
        fallbackRoles: ['coder', 'architect'],
        maxTokens: 12288,
        prompt: ({ goal }) => `Analyse this closely and report what you find:\n\n${goal}`,
      },
      {
        name: 'attack',
        role: 'architect',
        fallbackRoles: ['coder'],
        maxTokens: 8192,
        system:
          'You are the adversary of the analysis in front of you. Assume it is ' +
          'incomplete and partly wrong. Your job is to find what it missed and what ' +
          'it got wrong, not to agree with it.',
        prompt: ({ goal, prior }) =>
          `Subject:\n\n${goal}\n\nAnother analyst wrote:\n\n${clip(prior)}\n\n` +
          `What did they miss? What did they get wrong? What did they assert without ` +
          `support? Be concrete.`,
      },
      {
        name: 'judgement',
        role: 'reviewer',
        fallbackRoles: ['architect'],
        maxTokens: 12288,
        prompt: ({ goal, outputs }) => {
          const first = outputs.find(o => o.name === 'analyse')?.text ?? ''
          const attack = outputs.find(o => o.name === 'attack')?.text ?? ''
          return (
            `Subject:\n\n${goal}\n\nFirst analysis:\n\n${clip(first)}\n\n` +
            `The objections raised against it:\n\n${clip(attack, 6000)}\n\n` +
            `Write the final assessment. Keep what survived the objections, drop what ` +
            `did not, and say which objections you rejected and why.`
          )
        },
      },
    ],
  },
}
