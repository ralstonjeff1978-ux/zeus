import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Point the jobs DB at a throwaway file before the store module is imported.
// (The store reads this lazily on first use, so setting it here is enough.)
process.env.ZEUS_JOBS = resolve(
  tmpdir(),
  `zeus-accept-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
)

import { runCheck, coerceCheck, type AcceptanceCheck } from './acceptance.ts'
import { registerRecipe, startJob, runJob, store, type RunEvent } from './engine.ts'
import type { RegistryFile } from '../registry/schema.ts'

// The brain that runs verification commands is just the bun binary already
// executing this test — no model name anywhere, no network.
const BUN = process.execPath
const REGISTRY: RegistryFile = { version: 1, brains: [] }

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `zeus-accept-${tag}-`))
}

async function drain(
  id: string,
  opts: Partial<Parameters<typeof runJob>[1]> = {},
): Promise<RunEvent[]> {
  const events: RunEvent[] = []
  for await (const ev of runJob(id, { registry: REGISTRY, ...opts })) events.push(ev)
  return events
}

// ---------------------------------------------------------------------------
// The pure runner
// ---------------------------------------------------------------------------

test('command check: exit 0 passes, with evidence', async () => {
  const dir = tempDir('cmd-pass')
  const r = await runCheck({ kind: 'command', cmd: [BUN, '-e', 'process.exit(0)'] }, { cwd: dir })
  expect(r.passed).toBe(true)
  expect(r.evidence).toContain('exit: 0')
})

test('command check: a nonzero exit fails and captures stdout+stderr', async () => {
  const dir = tempDir('cmd-fail')
  const r = await runCheck(
    {
      kind: 'command',
      cmd: [BUN, '-e', 'console.log("OUT-MARKER"); console.error("ERR-MARKER"); process.exit(3)'],
    },
    { cwd: dir },
  )
  expect(r.passed).toBe(false)
  expect(r.evidence).toContain('exit code 3') // the reason
  expect(r.evidence).toContain('OUT-MARKER') // captured stdout
  expect(r.evidence).toContain('ERR-MARKER') // captured stderr
})

test('command check: expectStdout must be present', async () => {
  const dir = tempDir('cmd-stdout')
  const ok = await runCheck(
    { kind: 'command', cmd: [BUN, '-e', 'console.log("VERIFY_OK")'], expectStdout: 'VERIFY_OK' },
    { cwd: dir },
  )
  expect(ok.passed).toBe(true)
  const bad = await runCheck(
    { kind: 'command', cmd: [BUN, '-e', 'console.log("nope")'], expectStdout: 'VERIFY_OK' },
    { cwd: dir },
  )
  expect(bad.passed).toBe(false)
  expect(bad.evidence).toContain('stdout did not contain')
})

test('command check: a timeout is handled and killed, not waited out', async () => {
  const dir = tempDir('cmd-timeout')
  const start = Date.now()
  const r = await runCheck(
    { kind: 'command', cmd: [BUN, '-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 400 },
    { cwd: dir },
  )
  const elapsed = Date.now() - start
  expect(r.passed).toBe(false)
  expect(r.evidence).toContain('TIMED OUT')
  expect(elapsed).toBeLessThan(5000) // proof it was aborted, not run to completion
})

test('command check: a missing executable is a failed check, not a throw', async () => {
  const dir = tempDir('cmd-missing')
  const r = await runCheck(
    { kind: 'command', cmd: ['zeus-definitely-not-a-real-binary-xyz', '--version'] },
    { cwd: dir },
  )
  expect(r.passed).toBe(false)
})

test('file_exists check: missing then present', async () => {
  const dir = tempDir('fe')
  const missing = await runCheck({ kind: 'file_exists', path: 'artifact.txt' }, { cwd: dir })
  expect(missing.passed).toBe(false)
  writeFileSync(join(dir, 'artifact.txt'), 'hi')
  const present = await runCheck({ kind: 'file_exists', path: 'artifact.txt' }, { cwd: dir })
  expect(present.passed).toBe(true)
  expect(present.evidence).toContain('bytes')
})

test('json_valid check: valid, invalid, and required keys', async () => {
  const dir = tempDir('jv')
  writeFileSync(join(dir, 'good.json'), JSON.stringify({ name: 'z', version: 1 }))
  writeFileSync(join(dir, 'bad.json'), '{ not valid json ')

  expect((await runCheck({ kind: 'json_valid', path: 'good.json' }, { cwd: dir })).passed).toBe(true)

  const bad = await runCheck({ kind: 'json_valid', path: 'bad.json' }, { cwd: dir })
  expect(bad.passed).toBe(false)
  expect(bad.evidence).toContain('invalid JSON')

  const keysOk = await runCheck(
    { kind: 'json_valid', path: 'good.json', requireKeys: ['name', 'version'] },
    { cwd: dir },
  )
  expect(keysOk.passed).toBe(true)

  const keysMissing = await runCheck(
    { kind: 'json_valid', path: 'good.json', requireKeys: ['name', 'absent'] },
    { cwd: dir },
  )
  expect(keysMissing.passed).toBe(false)
  expect(keysMissing.evidence).toContain('missing keys')
})

test('all-composition passes only when every nested check passes', async () => {
  const dir = tempDir('all')
  writeFileSync(join(dir, 'log.txt'), 'build succeeded\n')

  const all = await runCheck(
    {
      kind: 'all',
      checks: [
        { kind: 'file_exists', path: 'log.txt' },
        { kind: 'file_contains', path: 'log.txt', needle: 'succeeded' },
      ],
    },
    { cwd: dir },
  )
  expect(all.passed).toBe(true)

  const allFail = await runCheck(
    {
      kind: 'all',
      checks: [
        { kind: 'file_exists', path: 'log.txt' },
        { kind: 'file_contains', path: 'log.txt', needle: 'FAILED' },
      ],
    },
    { cwd: dir },
  )
  expect(allFail.passed).toBe(false)
})

test('coerceCheck normalises the shapes a handler may return', () => {
  expect(coerceCheck(undefined)).toBeUndefined()
  expect(coerceCheck(null)).toBeUndefined()
  expect(coerceCheck([])).toBeUndefined()
  const one: AcceptanceCheck = { kind: 'file_exists', path: 'x' }
  expect(coerceCheck(one)).toEqual(one)
  expect(coerceCheck([one])).toEqual(one)
  expect(coerceCheck([one, { kind: 'file_exists', path: 'y' }])?.kind).toBe('all')
})

// ---------------------------------------------------------------------------
// The gate, wired into the engine + store
// ---------------------------------------------------------------------------

test('engine: a passing gate marks the step done', async () => {
  registerRecipe({
    kind: 'gate-pass-recipe',
    description: 'test',
    seed: () => [{ kind: 'work', title: 'write + verify' }],
    handlers: {
      work: async () => ({
        output: 'wrote it',
        accept: { kind: 'command', cmd: [BUN, '-e', 'process.exit(0)'] },
      }),
    },
  })
  const job = startJob({ kind: 'gate-pass-recipe', title: 'T', goal: 'g', workdir: tempDir('job-pass') })
  const events = await drain(job.id)
  expect(events.some(e => e.type === 'gate' && e.passed)).toBe(true)
  expect(store.steps(job.id)[0]!.status).toBe('done')
  expect(store.getJob(job.id)?.status).toBe('done')
})

test('engine: a failing gate fails the step and captures the evidence', async () => {
  registerRecipe({
    kind: 'gate-fail-recipe',
    description: 'test',
    seed: () => [{ kind: 'work', title: 'write + verify' }],
    handlers: {
      work: async () => ({
        output: 'wrote it',
        accept: {
          kind: 'command',
          cmd: [BUN, '-e', 'console.error("verification failed"); process.exit(1)'],
        },
      }),
    },
  })
  const job = startJob({ kind: 'gate-fail-recipe', title: 'T', goal: 'g', workdir: tempDir('job-fail') })
  const events = await drain(job.id, { maxAttempts: 1 })
  expect(events.some(e => e.type === 'gate' && !e.passed)).toBe(true)

  const step = store.steps(job.id)[0]!
  expect(step.status).toBe('failed')
  expect(step.error).toContain('Acceptance gate failed')
  expect(step.error).toContain('exit code 1')
  expect(step.error).toContain('verification failed') // captured stderr survived into the store
})

test('engine: a failed gate leaves the step re-runnable, and passes on resume', async () => {
  let runs = 0
  registerRecipe({
    kind: 'gate-resume-recipe',
    description: 'test',
    seed: () => [{ kind: 'build', title: 'build artifact' }],
    handlers: {
      build: async ctx => {
        runs++
        // First attempt writes nothing, so the gate must fail. The second
        // attempt produces the artifact the gate is checking for.
        if (runs >= 2) writeFileSync(join(ctx.workdir, 'artifact.txt'), 'built')
        return { output: `attempt ${runs}`, accept: { kind: 'file_exists', path: 'artifact.txt' } }
      },
    },
  })
  const job = startJob({
    kind: 'gate-resume-recipe',
    title: 'T',
    goal: 'g',
    workdir: tempDir('job-resume'),
  })

  // First pass: run exactly one step. Its gate fails; it must stay re-runnable.
  const first = await drain(job.id, { maxSteps: 1, maxAttempts: 5 })
  expect(first.some(e => e.type === 'gate' && !e.passed)).toBe(true)
  const afterFirst = store.steps(job.id)[0]!
  expect(afterFirst.status).toBe('pending') // re-runnable, not failed
  expect(store.nextPending(job.id)?.id).toBe(afterFirst.id) // the store agrees it is next

  // Resume: the step runs again, produces the artifact, the gate passes, done.
  const second = await drain(job.id, { maxAttempts: 5 })
  expect(second.some(e => e.type === 'gate' && e.passed)).toBe(true)
  expect(store.steps(job.id)[0]!.status).toBe('done')
  expect(existsSync(join(job.workdir, 'artifact.txt'))).toBe(true)
  expect(store.getJob(job.id)?.status).toBe('done')
})

test('engine: an acceptance gate persisted on the step is enforced too', async () => {
  // Not returned by the handler — carried on the step itself (e.g. seeded).
  registerRecipe({
    kind: 'gate-persisted-recipe',
    description: 'test',
    seed: () => [
      {
        kind: 'work',
        title: 'produce a report',
        acceptance: { kind: 'file_exists', path: 'report.json' },
      },
    ],
    handlers: {
      work: async ctx => {
        writeFileSync(join(ctx.workdir, 'report.json'), JSON.stringify({ ok: true }))
        return { output: 'done' }
      },
    },
  })
  const job = startJob({
    kind: 'gate-persisted-recipe',
    title: 'T',
    goal: 'g',
    workdir: tempDir('job-persisted'),
  })
  // The check round-tripped through the SQLite column.
  expect(store.steps(job.id)[0]!.acceptance).toContain('file_exists')
  const events = await drain(job.id)
  expect(events.some(e => e.type === 'gate' && e.passed)).toBe(true)
  expect(store.steps(job.id)[0]!.status).toBe('done')
})
