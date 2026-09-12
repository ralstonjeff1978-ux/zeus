import { existsSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * Capability discovery and acquisition.
 *
 * An agent that cannot tell whether a tool exists will confidently run it and
 * misread "command not found" as a failure of the task. And an agent that finds
 * a tool missing should be able to go and get it rather than stopping.
 *
 * Acquisition is real: it downloads and installs software on the user's machine.
 * Every path through it asks first, and the request states exactly what will be
 * run. That prompt is the control, so it is never bypassed here.
 */

const PROBE_TIMEOUT_MS = 15_000

type Manager = 'winget' | 'npm' | 'pip' | 'cargo' | 'git' | 'scoop' | 'choco'

/** How to ask a given manager to install something, and how to check it exists. */
const MANAGERS: Record<Manager, { probe: string[]; install: (pkg: string, dest?: string) => string[]; label: string }> = {
  winget: {
    probe: ['winget', '--version'],
    install: pkg => ['winget', 'install', '--silent', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', pkg],
    label: 'Windows Package Manager',
  },
  scoop: { probe: ['scoop', '--version'], install: pkg => ['scoop', 'install', pkg], label: 'Scoop' },
  choco: { probe: ['choco', '--version'], install: pkg => ['choco', 'install', '-y', pkg], label: 'Chocolatey' },
  npm: { probe: ['npm', '--version'], install: pkg => ['npm', 'install', '-g', pkg], label: 'npm (global)' },
  pip: { probe: ['python', '--version'], install: pkg => ['python', '-m', 'pip', 'install', '--user', pkg], label: 'pip' },
  cargo: { probe: ['cargo', '--version'], install: pkg => ['cargo', 'install', pkg], label: 'cargo' },
  git: {
    probe: ['git', '--version'],
    install: (repo, dest) => ['git', 'clone', '--depth', '1', repo, ...(dest ? [dest] : [])],
    label: 'git clone',
  },
}

async function run(argv: string[], cwd: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ code: number; out: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', signal: ctl.signal })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out: [stdout, stderr].filter(Boolean).join('\n').trim() }
  } catch (e) {
    return { code: -1, out: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

/** Is a command on PATH, and what version? */
async function which(cmd: string, cwd: string): Promise<{ found: boolean; detail: string }> {
  const locator = process.platform === 'win32' ? ['where', cmd] : ['which', cmd]
  const found = await run(locator, cwd, 8000)
  if (found.code !== 0 || !found.out.trim()) return { found: false, detail: '' }

  const path = found.out.split('\n')[0]!.trim()
  for (const flag of ['--version', '-version', '-V', 'version']) {
    const v = await run([cmd, flag], cwd, 8000)
    if (v.code === 0 && v.out.trim()) {
      return { found: true, detail: `${path}\n${v.out.split('\n').slice(0, 3).join('\n')}` }
    }
  }
  return { found: true, detail: path }
}

/**
 * Which package managers actually work on this machine.
 *
 * Probed rather than assumed, for the same reason brains are: a machine with
 * winget and no scoop is indistinguishable from the reverse until you ask.
 * Cached for the process, since the answer does not change mid-run and each
 * probe spawns a process.
 */
let managerCache: string[] | undefined
async function usableManagers(cwd: string): Promise<string[]> {
  if (managerCache) return managerCache
  const found: string[] = []
  await Promise.all(
    (Object.keys(MANAGERS) as Manager[]).map(async name => {
      const r = await run(MANAGERS[name].probe, cwd, 8000)
      if (r.code === 0) found.push(name)
    }),
  )
  managerCache = found.sort()
  return managerCache
}

export const checkCapabilityTool: Tool = {
  name: 'check_capability',
  description:
    'Check whether a command-line program is installed and usable on this machine, and report its version. Call this BEFORE trying to use an external tool you are not certain exists. Accepts several names at once.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      commands: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command names to check, e.g. ["python", "ffmpeg", "git", "kicad-cli"]',
      },
    },
    required: ['commands'],
  },
  async run(input: { commands: string[] }, ctx: ToolContext): Promise<ToolResult> {
    const names = (input.commands ?? []).slice(0, 12).filter(n => /^[a-zA-Z0-9._+-]+$/.test(n))
    if (!names.length) return fail('Give one or more plain command names.')

    const lines: string[] = []
    for (const n of names) {
      const r = await which(n, ctx.cwd)
      lines.push(r.found ? `AVAILABLE  ${n}\n  ${r.detail.replace(/\n/g, '\n  ')}` : `MISSING    ${n}`)
    }

    const missing = names.filter((_, i) => lines[i]!.startsWith('MISSING'))
    let hint = ''
    if (missing.length) {
      // Report which managers exist alongside the miss, so the agent's next
      // move is an install that can actually work rather than a guess.
      const usable = await usableManagers(ctx.cwd)
      hint = usable.length
        ? `\n\n${missing.length} missing. Package managers available on this machine: ${usable.join(', ')}. ` +
          `Use install_capability with one of those, or work around the missing tool.`
        : `\n\n${missing.length} missing, and no package manager is available on this machine. ` +
          `Do not attempt an install — solve the task another way, such as writing a small script yourself.`
    }
    return ok(lines.join('\n') + hint)
  },
}

export const installCapabilityTool: Tool = {
  name: 'install_capability',
  description:
    'Install a missing tool, or clone a git repository. Use only after check_capability confirms it is missing. Managers: winget, scoop, choco, npm, pip, cargo, git. The user is asked to approve the exact command before it runs.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      manager: {
        type: 'string',
        enum: ['winget', 'scoop', 'choco', 'npm', 'pip', 'cargo', 'git'],
        description: 'How to install it. Use "git" with a repository URL to clone source.',
      },
      package: {
        type: 'string',
        description: 'Package id, or repository URL when manager is "git"',
      },
      dest: {
        type: 'string',
        description: 'For git only: directory to clone into, relative to cwd',
      },
      reason: {
        type: 'string',
        description: 'One line on why this is needed. Shown to the user.',
      },
    },
    required: ['manager', 'package', 'reason'],
  },
  async run(
    input: { manager: Manager; package: string; dest?: string; reason: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const mgr = MANAGERS[input.manager]
    if (!mgr) return fail(`Unknown manager "${input.manager}".`)

    // The package name goes into a process argument, not a shell string, so it
    // cannot inject a second command. Still refuse obviously wrong shapes.
    if (input.manager === 'git') {
      if (!/^(https:\/\/|git@)[\w.@:/~+-]+$/.test(input.package)) {
        return fail('For git, package must be an https:// or git@ repository URL.')
      }
    } else if (!/^[A-Za-z0-9._@/+-]+$/.test(input.package)) {
      return fail(`"${input.package}" is not a valid package identifier.`)
    }

    let dest: string | undefined
    if (input.dest) {
      const abs = resolve(ctx.cwd, input.dest)
      const inside = ctx.allowedRoots.some(r => {
        const root = resolve(r)
        return abs === root || abs.startsWith(root + sep)
      })
      if (!inside) return fail(`Clone destination "${input.dest}" is outside the allowed roots.`)
      if (existsSync(abs)) return fail(`${input.dest} already exists.`)
      dest = abs
    }

    const available = await run(mgr.probe, ctx.cwd, 8000)
    if (available.code !== 0) {
      // Telling the agent only that this manager is missing sends it guessing,
      // and a second wrong guess usually ends with it abandoning the task. Name
      // the managers that actually work here so its next call can succeed.
      const usable = await usableManagers(ctx.cwd)
      return fail(
        `${mgr.label} is not installed on this machine, so it cannot install anything.\n` +
          (usable.length
            ? `Managers available here: ${usable.join(', ')}. Call install_capability again with one of those.`
            : `No package manager is available here. Do not try another — solve the task without ${input.package}, ` +
              `for example by writing a small script yourself.`),
      )
    }

    const argv = mgr.install(input.package, dest)
    const approved = await ctx.confirm(
      `Install software via ${mgr.label}`,
      `${argv.join(' ')}\n  (${input.reason})`,
    )
    if (!approved) {
      // A bare "denied" reads as a dead end and the agent stops. Say plainly
      // that the task is still expected, and name the way through: the tool is
      // unavailable, the goal is not cancelled.
      return fail(
        `The user declined to install ${input.package}. This does not cancel the task.\n` +
          `Do not ask again and do not try another package manager. Achieve the same result ` +
          `without ${input.package} — writing a short script with a language already on this ` +
          `machine is usually the fastest route.`,
      )
    }

    // Installers are slow; give them room but not forever.
    const res = await run(argv, ctx.cwd, 600_000)
    const tail = res.out.split('\n').slice(-25).join('\n')

    if (res.code !== 0) {
      return { content: `Install failed (exit ${res.code}):\n${tail}`, isError: true }
    }

    if (input.manager === 'git') {
      return ok(`Cloned ${input.package}${dest ? ` into ${input.dest}` : ''}.\n${tail}`)
    }

    // A freshly installed CLI often is not on the PATH of the already-running
    // shell. Say so, because the agent's next command will otherwise fail
    // confusingly and it will draw the wrong conclusion.
    const check = await which(input.package.split('/').pop()!.split('@')[0]!, ctx.cwd)
    const note = check.found
      ? `\nVerified on PATH.`
      : `\nInstalled, but not yet visible on this session's PATH. A new terminal may be needed before it can be run.`
    return ok(`Installed ${input.package} via ${mgr.label}.\n${tail}${note}`)
  },
}

export const fetchUrlTool: Tool = {
  name: 'fetch_url',
  description:
    'Download the contents of an https URL. Returns text directly, or saves to a file when save_to is given. Use for documentation, datasheets, schemas and reference material.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      save_to: { type: 'string', description: 'Path to write the body to, relative to cwd' },
      max_bytes: { type: 'integer', description: 'Defaults to 2000000' },
    },
    required: ['url'],
  },
  async run(input: { url: string; save_to?: string; max_bytes?: number }, ctx: ToolContext): Promise<ToolResult> {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      return fail(`"${input.url}" is not a valid URL.`)
    }
    if (parsed.protocol !== 'https:') return fail('Only https URLs are fetched.')

    if (!(await ctx.confirm('Fetch from the internet', parsed.href))) return fail('Denied by user.')

    const max = Math.min(input.max_bytes ?? 2_000_000, 20_000_000)
    let res: Response
    try {
      res = await fetch(parsed.href, {
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000),
        headers: { 'user-agent': 'Zeus' },
      })
    } catch (e) {
      return fail(`Fetch failed: ${(e as Error).message}`)
    }
    if (!res.ok) return fail(`HTTP ${res.status} from ${parsed.href}`)

    const buf = new Uint8Array(await res.arrayBuffer())
    const body = buf.slice(0, max)

    if (input.save_to) {
      const abs = resolve(ctx.cwd, input.save_to)
      const inside = ctx.allowedRoots.some(r => {
        const root = resolve(r)
        return abs === root || abs.startsWith(root + sep)
      })
      if (!inside) return fail(`save_to "${input.save_to}" is outside the allowed roots.`)
      await Bun.write(abs, body)
      return ok(`Saved ${body.byteLength} bytes to ${input.save_to}`)
    }

    const text = new TextDecoder().decode(body)
    const stripped = /html/i.test(res.headers.get('content-type') ?? '') ? htmlToText(text) : text
    return ok(stripped.slice(0, 120_000))
  },
}

/** Crude but adequate: strip tags so a datasheet or doc page is readable. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const capabilityTools: Tool[] = [checkCapabilityTool, installCapabilityTool, fetchUrlTool]
