import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RegistryFile } from '../registry/schema.ts'
import { routeText } from '../core/router.ts'
import { runAgent, DEFAULT_SYSTEM } from '../agent/loop.ts'
import { allTools, TOOL_SETS } from '../agent/tools/index.ts'
import type { Usage } from '../adapters/types.ts'

/**
 * Worktree swarm: several brains attempt the same *code change* at once, each
 * in its own git worktree, and the diffs are judged against each other.
 *
 * A text tournament compares answers. This compares work — files actually
 * edited, commands actually run, tests that actually passed or did not. For a
 * coding task that is a far better signal than prose about a coding task, and
 * it is the one place a modest local model can be checked objectively rather
 * than rhetorically.
 *
 * Isolation is the whole point. Each agent gets a real checkout on its own
 * branch and cannot see or clobber the others, so a failed attempt costs
 * nothing and the user's working tree is never touched until they adopt one.
 */

const exec = promisify(execFile)

export type Attempt = {
  brainId: string
  /** Absolute path of this attempt's worktree. */
  dir: string
  branch: string
  diff: string
  filesChanged: number
  insertions: number
  deletions: number
  summary?: string
  usage: Usage
  ms: number
  turns: number
  error?: string
  /** Result of the verification command, when one was given. */
  verify?: { ok: boolean; output: string }
}

export type WorktreeSwarmResult = {
  attempts: Attempt[]
  winner?: Attempt
  verdict?: string
  judgeBrainId?: string
  totalCostUsd: number
  /** Where the worktrees live, so the caller can offer to clean them up. */
  root: string
}

export type WorktreeSwarmOptions = {
  registry: RegistryFile
  /** Brain ids that will each attempt the task. */
  brains: string[]
  /** The repository to branch from. Must be a git working tree. */
  repo: string
  judge?: string
  /** Shell command run inside each worktree to check the work, e.g. "bun test". */
  verifyCmd?: string
  maxTurns?: number
  maxCostUsd?: number
  toolSet?: string
  signal?: AbortSignal
  onEvent?: (brainId: string, event: string, detail?: string) => void
}

export async function worktreeSwarm(
  task: string,
  opts: WorktreeSwarmOptions,
): Promise<WorktreeSwarmResult> {
  if (opts.brains.length < 1) throw new Error('Need at least one brain to attempt the task.')

  const repo = resolve(opts.repo)
  await assertGitRepo(repo)

  const runId = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  // Deliberately outside the repository. Zeus's home is `<cwd>/.zeus`, which
  // for a race started inside the repo would nest every worktree in the very
  // tree being raced on: git would see them as untracked, `git add -A` inside
  // an attempt would sweep up its rivals, and the adopted diff could carry
  // them into the user's tree. The system temp directory is always outside.
  const root = join(tmpdir(), 'zeus-worktrees', runId)
  await mkdir(root, { recursive: true })

  // Branch from the current HEAD so every attempt starts from identical state.
  // Uncommitted changes in the user's tree are deliberately NOT carried in:
  // an attempt must start from something reproducible.
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim()

  const attempts: Attempt[] = []
  for (const brainId of opts.brains) {
    const branch = `zeus/${runId}/${slug(brainId)}`
    const dir = join(root, slug(brainId))
    try {
      await git(repo, ['worktree', 'add', '--detach', dir, base])
      await git(dir, ['checkout', '-b', branch])
      attempts.push({
        brainId, dir, branch, diff: '', filesChanged: 0, insertions: 0,
        deletions: 0, usage: {}, ms: 0, turns: 0,
      })
    } catch (e) {
      attempts.push({
        brainId, dir, branch, diff: '', filesChanged: 0, insertions: 0,
        deletions: 0, usage: {}, ms: 0, turns: 0,
        error: `Could not create worktree: ${(e as Error).message}`,
      })
    }
  }

  // Same lane rule as the text tournament: brains sharing a local endpoint are
  // queued, because two large models on one GPU evict each other and both run
  // slower than they would in sequence. Different endpoints overlap freely.
  const lanes = new Map<string, Attempt[]>()
  for (const a of attempts) {
    if (a.error) continue
    const brain = opts.registry.brains.find(b => b.id === a.brainId)
    const lane = brain && brain.locality === 'local' ? brain.endpoint : `remote:${a.brainId}`
    const list = lanes.get(lane)
    if (list) list.push(a)
    else lanes.set(lane, [a])
  }

  await Promise.all(
    [...lanes.values()].map(async lane => {
      for (const a of lane) await attempt(task, a, opts)
    }),
  )

  let totalCostUsd = attempts.reduce((n, a) => n + (a.usage.costUsd ?? 0), 0)

  const usable = attempts.filter(a => !a.error && a.diff.trim())
  if (usable.length === 0) {
    return { attempts, totalCostUsd, root, verdict: 'No attempt produced any change.' }
  }

  // Verification, where it exists, outranks any judge's opinion. A diff that
  // fails the test suite does not win on style.
  const passing = usable.filter(a => !a.verify || a.verify.ok)
  const pool = passing.length ? passing : usable

  if (pool.length === 1) {
    return {
      attempts,
      winner: pool[0],
      totalCostUsd,
      root,
      verdict: passing.length === 1 && usable.length > 1
        ? 'Only one attempt both changed files and passed verification.'
        : 'Only one attempt produced a usable change.',
    }
  }

  const judged = await judgeDiffs(task, pool, opts)
  totalCostUsd += judged.costUsd
  return {
    attempts,
    winner: judged.winner ?? pool[0],
    verdict: judged.verdict,
    judgeBrainId: judged.judgeBrainId,
    totalCostUsd,
    root,
  }
}

async function attempt(task: string, a: Attempt, opts: WorktreeSwarmOptions): Promise<void> {
  const started = performance.now()
  const setName = opts.toolSet ?? 'code'
  const build = TOOL_SETS[setName]
  const tools = setName === 'all' || !build ? allTools() : build()

  opts.onEvent?.(a.brainId, 'start')

  try {
    for await (const ev of runAgent(task, {
      registry: opts.registry,
      target: { by: 'id', id: a.brainId },
      tools,
      // Attempts run unattended in a throwaway checkout, so there is no one to
      // ask. Containment is what makes this safe: allowedRoots is the worktree
      // alone, enforced in the tools rather than in the prompt.
      policy: { mode: 'auto' },
      cwd: a.dir,
      allowedRoots: [a.dir],
      systemPrompt: DEFAULT_SYSTEM,
      ask: async () => true,
      maxTurns: opts.maxTurns ?? 30,
      maxCostUsd: opts.maxCostUsd,
      route: { context: `worktree:${a.brainId}` },
      signal: opts.signal,
    })) {
      if (ev.type === 'turn') a.turns = ev.n
      else if (ev.type === 'tool_start') opts.onEvent?.(a.brainId, 'tool', ev.name)
      else if (ev.type === 'done') {
        a.usage = ev.usage
        a.summary = ev.summary
      } else if (ev.type === 'error') a.error = ev.message
    }
  } catch (e) {
    a.error = (e as Error).message
  }

  a.ms = Math.round(performance.now() - started)

  try {
    // Stage everything so new files appear in the diff — an attempt that solves
    // the task by adding a file would otherwise look like it did nothing.
    await git(a.dir, ['add', '-A'])
    a.diff = await git(a.dir, ['diff', '--cached'])
    const stat = await git(a.dir, ['diff', '--cached', '--shortstat'])
    const files = /(\d+) files? changed/.exec(stat)
    const ins = /(\d+) insertions?/.exec(stat)
    const del = /(\d+) deletions?/.exec(stat)
    a.filesChanged = files ? Number(files[1]) : 0
    a.insertions = ins ? Number(ins[1]) : 0
    a.deletions = del ? Number(del[1]) : 0
  } catch (e) {
    a.error ??= `Could not read the diff: ${(e as Error).message}`
  }

  if (opts.verifyCmd && a.diff.trim()) {
    opts.onEvent?.(a.brainId, 'verify')
    a.verify = await runVerify(a.dir, opts.verifyCmd)
  }

  opts.onEvent?.(a.brainId, 'done', a.error ?? `${a.filesChanged} files`)
}

/**
 * Run the verification command in the attempt's worktree.
 *
 * Exit status is the verdict. Output is captured either way because a failing
 * test tells the judge more than a passing one does.
 */
async function runVerify(dir: string, cmd: string): Promise<{ ok: boolean; output: string }> {
  const shell = process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/c', cmd] }
    : { file: '/bin/sh', args: ['-c', cmd] }
  try {
    const { stdout, stderr } = await exec(shell.file, shell.args, {
      cwd: dir,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, output: tail(stdout + stderr) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: tail((err.stdout ?? '') + (err.stderr ?? '') || err.message) }
  }
}

async function judgeDiffs(
  task: string,
  pool: Attempt[],
  opts: WorktreeSwarmOptions,
): Promise<{ winner?: Attempt; verdict?: string; judgeBrainId?: string; costUsd: number }> {
  const competing = new Set(pool.map(a => a.brainId))
  const judgeId = opts.judge ?? pickJudge(opts.registry, competing)

  if (opts.judge && competing.has(opts.judge)) {
    throw new Error(`Judge "${opts.judge}" is also competing. A brain cannot judge its own work.`)
  }
  if (!judgeId) {
    return {
      costUsd: 0,
      verdict:
        'No impartial judge was available — every candidate brain also competed. ' +
        'Register another brain, or pass --judge, to have a winner selected.',
    }
  }

  // Anonymised and shuffled, for the same reason as the text tournament: a
  // judge that recognises the author grades the author, not the work.
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  const labelled = shuffled.map((a, i) => ({ label: String.fromCharCode(65 + i), a }))

  const submissions = labelled
    .map(({ label, a }) => {
      const verify = a.verify
        ? `\nVerification: ${a.verify.ok ? 'PASSED' : 'FAILED'}\n${a.verify.output.slice(0, 1500)}`
        : ''
      return `### Attempt ${label}\n${a.summary ? `Author's summary: ${a.summary}\n` : ''}` +
        `Changed ${a.filesChanged} file(s), +${a.insertions}/-${a.deletions}${verify}\n\n` +
        `\`\`\`diff\n${clipDiff(a.diff)}\n\`\`\``
    })
    .join('\n\n---\n\n')

  const prompt = `Several engineers independently attempted this task on identical copies of the same repository:

--- TASK ---
${task}
--- END TASK ---

Here are their diffs.

${submissions}

---

Judge them as a senior engineer reviewing pull requests. In order of importance:
1. Does it actually accomplish the task?
2. Is it correct — will it work, and does it break anything else?
3. Does it fit the existing code, and is it the smallest change that does the job?

A diff that passed verification beats one that did not. A large diff that does
extra unrequested work is worse than a small one that does exactly the task.

Write two or three sentences comparing them, then on the final line write exactly:
WINNER: <letter>`

  try {
    const res = await routeText(
      opts.registry,
      { by: 'id', id: judgeId },
      {
        system:
          'You are reviewing code you did not write. Be decisive and specific. ' +
          'Do not reward size. Do not hedge — you must pick one.',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 2048,
      },
      { context: 'worktree:judge', signal: opts.signal, retries: 1 },
    )
    const m = /WINNER:\s*([A-Z])/i.exec(res.text)
    return {
      winner: m ? labelled.find(l => l.label === m[1]!.toUpperCase())?.a : undefined,
      verdict: res.text,
      judgeBrainId: res.brainId,
      costUsd: res.usage.costUsd ?? 0,
    }
  } catch (e) {
    return { costUsd: 0, verdict: `The judge failed: ${(e as Error).message}` }
  }
}

/**
 * Apply a winning attempt to the real working tree.
 *
 * The diff is applied rather than the branch merged, so the user ends up with
 * ordinary uncommitted changes they can read, edit or throw away — nothing is
 * committed to their repository on an agent's say-so.
 */
export async function adopt(repo: string, a: Attempt): Promise<void> {
  if (!a.diff.trim()) throw new Error('That attempt changed nothing.')
  const proc = Bun.spawn(['git', 'apply', '--3way', '--whitespace=nowarn', '-'], {
    cwd: resolve(repo),
    stdin: new TextEncoder().encode(a.diff),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`Could not apply the diff: ${err.trim() || `git apply exited ${code}`}`)
  }
}

/** Remove the worktrees and their branches. Best effort — never throws. */
export async function cleanup(repo: string, result: WorktreeSwarmResult): Promise<void> {
  for (const a of result.attempts) {
    try {
      await git(repo, ['worktree', 'remove', '--force', a.dir])
    } catch {
      /* already gone, or never made */
    }
    try {
      await git(repo, ['branch', '-D', a.branch])
    } catch {
      /* never created */
    }
  }
  await rm(result.root, { recursive: true, force: true }).catch(() => {})
  await git(repo, ['worktree', 'prune']).catch(() => {})
}

/* ------------------------------------------------------------------ */

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

async function assertGitRepo(dir: string): Promise<void> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree'])
    if (out.trim() !== 'true') throw new Error('not a work tree')
  } catch {
    throw new Error(
      `${dir} is not a git repository.\n` +
        'The worktree swarm needs one: it gives each brain an isolated checkout and ' +
        'compares the diffs. Run `git init` and make one commit, then try again.',
    )
  }
  try {
    await git(dir, ['rev-parse', 'HEAD'])
  } catch {
    throw new Error('This repository has no commits yet. Make one commit so attempts have a base.')
  }
}

function pickJudge(reg: RegistryFile, competing: Set<string>): string | undefined {
  const candidates = reg.brains.filter(
    b => b.kind === 'chat' && !competing.has(b.id) && b.probed?.reachable !== false,
  )
  const reviewer = candidates.find(b => b.roles.includes('reviewer'))
  return (reviewer ?? candidates[0])?.id
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 48)
}

function tail(s: string, max = 4000): string {
  return s.length > max ? '…' + s.slice(-max) : s
}

/**
 * Keep diffs inside a context window. Truncating the tail is right here: the
 * start of a diff carries the file headers and the substance of the change.
 */
function clipDiff(d: string, max = 20000): string {
  return d.length > max ? d.slice(0, max) + '\n\n[…diff truncated]' : d
}
