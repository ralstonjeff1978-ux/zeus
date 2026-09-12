import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { loadRegistry } from '../registry/registry.ts'
import { runAgent, DEFAULT_SYSTEM } from '../agent/loop.ts'
import { allTools, TOOL_SETS } from '../agent/tools/index.ts'
import type { PermissionMode, Policy } from '../agent/permissions.ts'
import type { RouteTarget } from '../core/router.ts'
import { C } from './style.ts'

/**
 * `zeus do` — run the agent loop against a task.
 * This is the interactive coding-tool entry point.
 */

export type AgentCmdOptions = {
  brain?: string
  role?: string
  mode: PermissionMode
  cwd: string
  maxTurns?: number
  maxCostUsd?: number
  fallbacks?: string[]
  toolSet?: string
  yes: boolean
}

export async function runAgentCommand(prompt: string, opts: AgentCmdOptions): Promise<number> {
  const reg = await loadRegistry()
  const target: RouteTarget = opts.brain
    ? { by: 'id', id: opts.brain }
    : opts.role
      ? { by: 'role', role: opts.role }
      : { by: 'id', id: reg.default ?? '' }

  if (target.by === 'id' && !target.id) {
    console.error(C.red('No brain selected and no default set. Use --brain <id>, or set "default:" in brains.yaml.'))
    return 2
  }

  const policy: Policy = { mode: opts.mode }

  const setName = opts.toolSet ?? 'all'
  const build = TOOL_SETS[setName]
  if (!build) {
    console.error(C.red(`Unknown tool set "${setName}". Available: ${Object.keys(TOOL_SETS).join(', ')}`))
    return 2
  }
  const tools = setName === 'all' ? allTools() : build()
  const rl = opts.yes
    ? undefined
    : createInterface({ input: process.stdin, output: process.stdout })

  const ask = async (action: string, detail: string): Promise<boolean> => {
    if (opts.yes || !rl) return true
    console.log(`\n${C.yellow('⚑ ' + action)}`)
    for (const line of detail.split('\n')) console.log(`  ${C.dim(line)}`)
    const answer = (await rl.question(`${C.bold('  allow?')} [y/N] `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }

  const ctl = new AbortController()
  const onSigint = () => {
    console.log(C.dim('\n(stopping…)'))
    ctl.abort()
  }
  process.on('SIGINT', onSigint)

  const cwd = resolve(opts.cwd)
  let exitCode = 0

  try {
    for await (const ev of runAgent(prompt, {
      registry: reg,
      target,
      tools,
      policy,
      cwd,
      allowedRoots: [cwd],
      systemPrompt: DEFAULT_SYSTEM,
      ask,
      maxTurns: opts.maxTurns,
      maxCostUsd: opts.maxCostUsd,
      route: { fallbacks: opts.fallbacks, context: 'zeus do' },
      signal: ctl.signal,
    })) {
      switch (ev.type) {
        case 'turn':
          console.log(C.dim(`\n─── turn ${ev.n}${ev.brainId ? ` · ${ev.brainId}` : ''} ───`))
          break
        case 'text':
          process.stdout.write(ev.text)
          break
        case 'tool_start':
          console.log(`\n${C.cyan('▸ ' + ev.name)} ${C.dim(preview(ev.input))}`)
          break
        case 'tool_end':
          console.log(
            ev.isError
              ? `${C.red('  ✗')} ${firstLine(ev.result)}`
              : `${C.green('  ✓')} ${C.dim(firstLine(ev.result))}`,
          )
          break
        case 'error':
          console.error(`\n${C.red(ev.message)}`)
          exitCode = 1
          break
        case 'done': {
          const u = ev.usage
          const cost = u.costUsd ? ` · $${u.costUsd.toFixed(4)}` : ''
          if (ev.summary) console.log(`\n${C.bold(ev.summary)}`)
          console.log(
            C.dim(`\n${ev.reason} · ${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out${cost}`),
          )
          if (ev.reason === 'stalled') {
            console.error(
              C.yellow(
                '\nThis brain described the next step instead of doing it, and did not recover ' +
                  'when prompted. Treat the summary above as a claim, not a result — check the files.',
              ),
            )
          }
          if (ev.reason === 'max_turns' || ev.reason === 'stalled') exitCode = 1
          break
        }
      }
    }
  } finally {
    process.off('SIGINT', onSigint)
    rl?.close()
  }

  return exitCode
}

function preview(input: unknown): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input)
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? ''
  return line.length > 140 ? line.slice(0, 140) + '…' : line
}
