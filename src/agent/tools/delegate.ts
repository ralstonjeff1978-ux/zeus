import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'
import { loadRegistry } from '../../registry/registry.ts'
import { candidateBrains } from '../../registry/candidates.ts'

/**
 * Delegation and swarm access, exposed to the brain itself.
 *
 * A brain that can hand a bounded task to a specialist — or put a hard question
 * to three brains and take the judged winner — is doing something no
 * single-model tool can. These are the swarm primitives, made available from
 * inside the agent loop rather than only from the command line.
 *
 * The imports are deferred to break the cycle with the agent loop, which pulls
 * in this module through the tool registry.
 */

export const delegateTool: Tool = {
  name: 'delegate',
  description:
    'Hand a self-contained task to another brain and get its answer back. Use to route work to a specialist (a coder, a reviewer, a security brain), or to keep a large investigation out of your own context. Give complete instructions — the other brain sees only what you write here.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Complete, self-contained instructions' },
      brain: { type: 'string', description: 'Brain id. Omit to select by role.' },
      role: { type: 'string', description: 'Role to route to, e.g. coder, reviewer, security, vision' },
      tools: {
        type: 'boolean',
        description: 'Give the delegate file and shell access. Defaults to false — it answers from the task text alone.',
      },
      max_turns: { type: 'integer', description: 'Defaults to 12 when tools are enabled' },
    },
    required: ['task'],
  },
  async run(
    input: { task: string; brain?: string; role?: string; tools?: boolean; max_turns?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reg = await loadRegistry()
    const target = input.brain
      ? ({ by: 'id', id: input.brain } as const)
      : input.role
        ? ({ by: 'role', role: input.role } as const)
        : ({ by: 'id', id: reg.default ?? '' } as const)

    if (target.by === 'id' && !target.id) {
      return fail('No brain or role given, and the registry has no default.')
    }

    const label = input.brain ?? input.role ?? reg.default ?? 'default'

    if (!input.tools) {
      const { routeText } = await import('../../core/router.ts')
      try {
        const res = await routeText(
          reg,
          target,
          {
            messages: [{ role: 'user', content: [{ type: 'text', text: input.task }] }],
            maxTokens: 8192,
          },
          { context: 'delegate', signal: ctx.signal, retries: 2 },
        )
        return ok(`[${res.brainId ?? label}]\n\n${res.text}`)
      } catch (e) {
        return fail(`Delegate failed: ${(e as Error).message}`)
      }
    }

    if (!(await ctx.confirm('Delegate with tool access', `${label}: ${input.task.slice(0, 200)}`))) {
      return fail('Denied by user.')
    }

    const { runAgent, DEFAULT_SYSTEM } = await import('../loop.ts')
    const { ALL_TOOLS } = await import('./index.ts')

    const transcript: string[] = []
    let summary = ''
    try {
      for await (const ev of runAgent(input.task, {
        registry: reg,
        target,
        // A delegate does not get to spawn further delegates; that recursion is
        // how a runaway happens.
        tools: ALL_TOOLS.filter(t => t.name !== 'delegate' && t.name !== 'tournament'),
        policy: { mode: 'auto-edit' },
        cwd: ctx.cwd,
        allowedRoots: ctx.allowedRoots,
        systemPrompt: DEFAULT_SYSTEM,
        ask: ctx.confirm,
        maxTurns: input.max_turns ?? 12,
        route: { context: 'delegate' },
        signal: ctx.signal,
      })) {
        if (ev.type === 'tool_start') transcript.push(`  ▸ ${ev.name}`)
        else if (ev.type === 'tool_end' && ev.isError) transcript.push(`  ✗ ${ev.result.split('\n')[0]}`)
        else if (ev.type === 'done') summary = ev.summary ?? ''
        else if (ev.type === 'error') return fail(`Delegate failed: ${ev.message}`)
      }
    } catch (e) {
      return fail(`Delegate failed: ${(e as Error).message}`)
    }

    return ok(`[${label}]\n${transcript.slice(0, 40).join('\n')}\n\n${summary || '(no summary given)'}`)
  },
}

export const tournamentTool: Tool = {
  name: 'tournament',
  description:
    'Put one hard question to several brains independently and have a different brain judge the answers. Use when correctness matters more than speed and you are not confident in a single answer.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The task, stated completely' },
      brains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Brain ids to compete. At least two. Omit to use every reachable chat brain.',
      },
      judge: { type: 'string', description: 'Brain id to judge. Must not be competing.' },
    },
    required: ['question'],
  },
  async run(input: { question: string; brains?: string[]; judge?: string }, ctx: ToolContext): Promise<ToolResult> {
    const reg = await loadRegistry()
    let contestants = input.brains

    if (!contestants?.length) {
      contestants = candidateBrains(reg, {
        exclude: input.judge ? [input.judge] : [],
        limit: 3,
      }).map(b => b.id)
    }
    if (contestants.length < 2) {
      return fail('A tournament needs at least two chat brains in the registry.')
    }

    if (!(await ctx.confirm('Run a tournament', `${contestants.join(', ')} — ${input.question.slice(0, 160)}`))) {
      return fail('Denied by user.')
    }

    const { tournament } = await import('../../swarm/tournament.ts')
    try {
      const res = await tournament(input.question, {
        registry: reg,
        contestants,
        judge: input.judge,
        judgeRole: 'reviewer',
        signal: ctx.signal,
        context: 'tournament-tool',
      })

      const failed = res.contestants.filter(c => c.error)
      const lines = [
        `Entrants: ${res.contestants.map(c => `${c.brainId}${c.error ? ' (failed)' : ` ${c.ms}ms`}`).join(', ')}`,
        res.judgeBrainId ? `Judge: ${res.judgeBrainId}` : '',
        failed.length ? `${failed.length} entrant(s) failed: ${failed.map(f => f.error?.slice(0, 80)).join('; ')}` : '',
        '',
        res.verdict ? `--- verdict ---\n${res.verdict}\n` : '',
        res.winner ? `--- winning answer (${res.winner.brainId}) ---\n${res.winner.text}` : 'No winner was selected.',
      ].filter(Boolean)

      return ok(lines.join('\n'))
    } catch (e) {
      return fail(`Tournament failed: ${(e as Error).message}`)
    }
  },
}

export const delegateTools: Tool[] = [delegateTool, tournamentTool]
