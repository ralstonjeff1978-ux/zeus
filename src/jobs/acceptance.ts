import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Acceptance gates — "run what it writes".
 *
 * A step that produces code or artifacts has not really succeeded until
 * something checked that the product actually works. Left to a brain's own word,
 * "I wrote the program" and "the program runs" are the same sentence; they are
 * not the same fact. An acceptance check closes that gap: after a step writes
 * its output, the engine runs a verification — a build, a test, a lint, an
 * execution, or a structural check on a file — and only lets the step be marked
 * `done` if it passes. A failed gate feeds the ordinary retry/resume path.
 *
 * This module is deliberately pure and brain-agnostic. It contains no model
 * names and asks nothing of the network. It takes a declarative check and
 * returns a verdict with the evidence behind it, so a caller can store that
 * evidence and a human can see exactly why a gate passed or failed.
 */

/** A command to run. Success is defined by exit code and (optionally) output. */
export type CommandCheck = {
  kind: 'command'
  /**
   * The command to run. An argv array is preferred — it is portable and needs
   * no shell quoting. A plain string is run through the platform shell as a
   * convenience (cmd on Windows, sh elsewhere).
   */
  cmd: string[] | string
  /** Working directory, resolved against the gate's base dir. Defaults to it. */
  cwd?: string
  /** Milliseconds before the command is killed and the check fails. */
  timeoutMs?: number
  /** Exit code that counts as success. Defaults to 0. */
  expectExitCode?: number
  /** If set, stdout must contain this substring for the check to pass. */
  expectStdout?: string
  /** If set, stderr must contain this substring for the check to pass. */
  expectStderr?: string
  /** Extra environment, merged over the current environment. */
  env?: Record<string, string>
}

/** The file must exist and be a regular file. */
export type FileExistsCheck = { kind: 'file_exists'; path: string }

/** The file must exist and parse as JSON; optionally hold given top-level keys. */
export type JsonValidCheck = { kind: 'json_valid'; path: string; requireKeys?: string[] }

/** The file must exist and contain the given substring. */
export type FileContainsCheck = { kind: 'file_contains'; path: string; needle: string }

/** Every nested check must pass. Evidence stops at the first failure. */
export type AllCheck = { kind: 'all'; checks: AcceptanceCheck[] }

export type AcceptanceCheck =
  | CommandCheck
  | FileExistsCheck
  | JsonValidCheck
  | FileContainsCheck
  | AllCheck

export type AcceptanceResult = {
  /** True only if the check's condition was met. */
  passed: boolean
  /** Human-readable proof: exit codes, captured output, parse errors, paths. */
  evidence: string
}

export type RunCheckOptions = {
  /** Base directory for relative paths and command cwd. Defaults to process.cwd(). */
  cwd?: string
  /** Fallback timeout for command checks that do not set their own. */
  timeoutMs?: number
  /** Abort the check (and any running command) early. */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_EVIDENCE = 8_000

/** Keep evidence bounded so it fits comfortably in a DB row and a terminal. */
function clip(s: string): string {
  if (s.length <= MAX_EVIDENCE) return s
  const head = s.slice(0, Math.floor(MAX_EVIDENCE * 0.7))
  const tail = s.slice(-Math.floor(MAX_EVIDENCE * 0.25))
  return `${head}\n... [${s.length - head.length - tail.length} characters trimmed] ...\n${tail}`
}

/** An argv array runs directly; a string goes through the platform shell. */
function toArgv(cmd: string[] | string): string[] {
  if (Array.isArray(cmd)) return cmd
  return process.platform === 'win32' ? ['cmd', '/d', '/s', '/c', cmd] : ['sh', '-c', cmd]
}

function showArgv(cmd: string[] | string): string {
  return Array.isArray(cmd) ? cmd.join(' ') : cmd
}

async function runCommandCheck(check: CommandCheck, opts: RunCheckOptions): Promise<AcceptanceResult> {
  const base = opts.cwd ?? process.cwd()
  const cwd = resolve(base, check.cwd ?? '.')
  const timeoutMs = check.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const expectExitCode = check.expectExitCode ?? 0

  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  opts.signal?.addEventListener('abort', onAbort)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctl.abort()
  }, timeoutMs)

  try {
    // stdin is set to 'ignore' on purpose. A verification command that blocks
    // waiting for input would otherwise hang until the timeout; worse, on
    // Windows an inherited stdin handle is a known source of failures in test
    // runners (pytest and friends). Giving the child no stdin makes it fail
    // fast and deterministically instead.
    const proc = Bun.spawn(toArgv(check.cmd), {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctl.signal,
      env: { ...process.env, ...(check.env ?? {}) },
    })

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
      proc.exited.catch(() => -1),
    ])

    const reasons: string[] = []
    if (timedOut) reasons.push(`timed out after ${timeoutMs}ms`)
    if (code !== expectExitCode) reasons.push(`exit code ${code}, expected ${expectExitCode}`)
    if (check.expectStdout !== undefined && !stdout.includes(check.expectStdout)) {
      reasons.push(`stdout did not contain ${JSON.stringify(check.expectStdout)}`)
    }
    if (check.expectStderr !== undefined && !stderr.includes(check.expectStderr)) {
      reasons.push(`stderr did not contain ${JSON.stringify(check.expectStderr)}`)
    }
    const passed = reasons.length === 0

    const evidence =
      `command: ${showArgv(check.cmd)}\n` +
      `cwd: ${cwd}\n` +
      `exit: ${code} (expected ${expectExitCode})${timedOut ? ' — TIMED OUT' : ''}\n` +
      `verdict: ${passed ? 'passed' : `failed — ${reasons.join('; ')}`}\n` +
      `--- stdout ---\n${stdout.trimEnd() || '(empty)'}\n` +
      `--- stderr ---\n${stderr.trimEnd() || '(empty)'}`

    return { passed, evidence: clip(evidence) }
  } catch (e) {
    // The command could not be launched at all (e.g. executable not found).
    return {
      passed: false,
      evidence: clip(`command: ${showArgv(check.cmd)}\ncwd: ${cwd}\nverdict: failed — could not run: ${(e as Error).message}`),
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

function runFileExistsCheck(check: FileExistsCheck, opts: RunCheckOptions): AcceptanceResult {
  const p = resolve(opts.cwd ?? process.cwd(), check.path)
  if (!existsSync(p)) return { passed: false, evidence: `file_exists: ${p}\nverdict: failed — does not exist` }
  const st = statSync(p)
  if (!st.isFile()) return { passed: false, evidence: `file_exists: ${p}\nverdict: failed — exists but is not a regular file` }
  return { passed: true, evidence: `file_exists: ${p}\nverdict: passed — ${st.size} bytes` }
}

function runJsonValidCheck(check: JsonValidCheck, opts: RunCheckOptions): AcceptanceResult {
  const p = resolve(opts.cwd ?? process.cwd(), check.path)
  if (!existsSync(p)) return { passed: false, evidence: `json_valid: ${p}\nverdict: failed — does not exist` }
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    return { passed: false, evidence: `json_valid: ${p}\nverdict: failed — unreadable: ${(e as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { passed: false, evidence: clip(`json_valid: ${p}\nverdict: failed — invalid JSON: ${(e as Error).message}`) }
  }
  if (check.requireKeys?.length) {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { passed: false, evidence: `json_valid: ${p}\nverdict: failed — expected a JSON object with keys ${check.requireKeys.join(', ')}` }
    }
    const have = parsed as Record<string, unknown>
    const missing = check.requireKeys.filter(k => !(k in have))
    if (missing.length) {
      return { passed: false, evidence: `json_valid: ${p}\nverdict: failed — missing keys: ${missing.join(', ')}` }
    }
  }
  return { passed: true, evidence: `json_valid: ${p}\nverdict: passed` }
}

function runFileContainsCheck(check: FileContainsCheck, opts: RunCheckOptions): AcceptanceResult {
  const p = resolve(opts.cwd ?? process.cwd(), check.path)
  if (!existsSync(p)) return { passed: false, evidence: `file_contains: ${p}\nverdict: failed — does not exist` }
  let raw: string
  try {
    raw = readFileSync(p, 'utf8')
  } catch (e) {
    return { passed: false, evidence: `file_contains: ${p}\nverdict: failed — unreadable: ${(e as Error).message}` }
  }
  const passed = raw.includes(check.needle)
  return {
    passed,
    evidence: `file_contains: ${p}\nneedle: ${JSON.stringify(check.needle)}\nverdict: ${passed ? 'passed' : 'failed — not found'}`,
  }
}

async function runAllCheck(check: AllCheck, opts: RunCheckOptions): Promise<AcceptanceResult> {
  const parts: string[] = []
  for (let i = 0; i < check.checks.length; i++) {
    const sub = await runCheck(check.checks[i]!, opts)
    parts.push(`[${i + 1}/${check.checks.length}] ${check.checks[i]!.kind} — ${sub.passed ? 'passed' : 'FAILED'}\n${sub.evidence}`)
    // Gate semantics: stop at the first failure so a slow later command is not
    // run needlessly, but keep the evidence gathered so far.
    if (!sub.passed) return { passed: false, evidence: clip(parts.join('\n\n')) }
  }
  return { passed: true, evidence: clip(parts.join('\n\n')) || 'all: no checks — vacuously passed' }
}

/**
 * Run a single acceptance check and return whether it passed, with evidence.
 * Never throws for an expected failure (a missing file, a non-zero exit, a
 * parse error, a timeout) — those are ordinary `passed: false` results.
 */
export async function runCheck(check: AcceptanceCheck, opts: RunCheckOptions = {}): Promise<AcceptanceResult> {
  switch (check.kind) {
    case 'command':
      return runCommandCheck(check, opts)
    case 'file_exists':
      return runFileExistsCheck(check, opts)
    case 'json_valid':
      return runJsonValidCheck(check, opts)
    case 'file_contains':
      return runFileContainsCheck(check, opts)
    case 'all':
      return runAllCheck(check, opts)
    default: {
      // Exhaustiveness guard: an unknown kind is a programming error, reported
      // as a failed gate rather than a thrown exception.
      const bad = check as { kind?: unknown }
      return { passed: false, evidence: `unknown acceptance check kind: ${String(bad?.kind)}` }
    }
  }
}

/** Normalise a handler's `accept` return into a single check (or nothing). */
export function coerceCheck(
  accept: AcceptanceCheck | AcceptanceCheck[] | null | undefined,
): AcceptanceCheck | undefined {
  if (!accept) return undefined
  if (Array.isArray(accept)) {
    if (accept.length === 0) return undefined
    if (accept.length === 1) return accept[0]
    return { kind: 'all', checks: accept }
  }
  return accept
}
