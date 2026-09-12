import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * Shell execution.
 *
 * The dangerous-command screen below is a speed bump for accidents, not a
 * sandbox. It catches an agent that means well and typed the wrong thing; it
 * will not stop one that is actively trying to get around it. Real isolation
 * comes from the allowed-roots containment and, later, from running the agent
 * in a worktree it cannot escape.
 */

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 60_000

/** Patterns that destroy things broadly enough to be worth a hard stop. */
const DESTRUCTIVE: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, why: 'recursive or forced delete' },
  { re: /\bRemove-Item\b.*-Recurse.*-Force/i, why: 'recursive forced delete' },
  { re: /\bformat\b\s+[a-z]:/i, why: 'disk format' },
  { re: /\bmkfs\b/, why: 'filesystem creation' },
  { re: /\bdd\b\s+if=.*\bof=\/dev\//, why: 'raw device write' },
  { re: />\s*\/dev\/[sh]d[a-z]/, why: 'raw device write' },
  { re: /\bgit\s+push\b.*--force(?!-with-lease)/, why: 'force push' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'discards uncommitted work' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/, why: 'deletes untracked files' },
  { re: /\bshutdown\b|\breboot\b|\bStop-Computer\b/i, why: 'shuts the machine down' },
  { re: /\bnetsh\b|\biptables\b|\bufw\s+(disable|reset)/i, why: 'changes network/firewall config' },
  { re: /\breg\s+delete\b|\bRemove-ItemProperty\b.*HK(LM|CU)/i, why: 'registry deletion' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh|\biwr\b[^|]*\|\s*iex/i, why: 'pipes a remote script straight into a shell' },
]

function screen(command: string): string | undefined {
  for (const d of DESTRUCTIVE) if (d.re.test(command)) return d.why
  return undefined
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s
  const head = s.slice(0, MAX_OUTPUT * 0.7)
  const tail = s.slice(-MAX_OUTPUT * 0.25)
  return `${head}\n\n... [${s.length - head.length - tail.length} characters trimmed] ...\n\n${tail}`
}

async function execute(
  argv: string[],
  ctx: ToolContext,
  timeoutMs: number,
): Promise<{ code: number; out: string; timedOut: boolean }> {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  ctx.signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => ctl.abort(), timeoutMs)

  try {
    const proc = Bun.spawn(argv, {
      cwd: ctx.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctl.signal,
      env: { ...process.env, ZEUS_AGENT: '1' },
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const merged = [stdout, stderr].filter(Boolean).join('\n').trimEnd()
    return { code, out: merged, timedOut: ctl.signal.aborted }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', onAbort)
  }
}

function makeShellTool(opts: {
  name: string
  description: string
  argv: (command: string) => string[]
}): Tool {
  return {
    name: opts.name,
    description: opts.description,
    mutates: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run' },
        timeout_ms: { type: 'integer', description: `Defaults to ${DEFAULT_TIMEOUT_MS}` },
        purpose: { type: 'string', description: 'One short line on why, shown to the user when confirming' },
      },
      required: ['command'],
    },
    async run(
      input: { command: string; timeout_ms?: number; purpose?: string },
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const cmd = (input.command ?? '').trim()
      if (!cmd) return fail('No command given.')

      const danger = screen(cmd)
      const label = danger ? `Run ${opts.name} — ${danger.toUpperCase()}` : `Run ${opts.name}`
      const detail = input.purpose ? `${cmd}\n  (${input.purpose})` : cmd
      if (!(await ctx.confirm(label, detail))) return fail('Denied by user.')

      const timeout = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 600_000)
      let res: { code: number; out: string; timedOut: boolean }
      try {
        res = await execute(opts.argv(cmd), ctx, timeout)
      } catch (e) {
        return fail(`Could not run command: ${(e as Error).message}`)
      }

      if (res.timedOut) {
        return fail(`Timed out after ${timeout}ms.\n${truncate(res.out)}`)
      }
      const body = res.out || '(no output)'
      if (res.code !== 0) {
        return { content: `Exit code ${res.code}\n${truncate(body)}`, isError: true }
      }
      return ok(truncate(body), `${opts.name}: ${cmd.slice(0, 60)}`)
    },
  }
}

export const powershellTool = makeShellTool({
  name: 'powershell',
  description:
    'Run a PowerShell command. This is the native shell on Windows — prefer it for anything touching Windows paths, services, or the registry.',
  argv: cmd => ['pwsh', '-NoProfile', '-NonInteractive', '-Command', cmd],
})

export const bashTool = makeShellTool({
  name: 'bash',
  description:
    'Run a POSIX shell command. Use for git, build tools, and anything expecting Unix syntax.',
  argv: cmd => ['bash', '-lc', cmd],
})

export const shellTools: Tool[] = [powershellTool, bashTool]
