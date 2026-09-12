import { test, expect, beforeAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.ZEUS_JOBS = resolve(tmpdir(), `zeus-jobs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)

import {
  createJob, getJob, listJobs, addStep, updateStep, steps,
  nextPending, progress, reclaimRunning,
} from './store.ts'

function newJob(id: string) {
  return createJob({ id, kind: 'book', title: 'T', goal: 'G', state: '{}', workdir: '.' })
}

test('createJob round-trips through getJob', () => {
  newJob('job1')
  const j = getJob('job1')
  expect(j?.id).toBe('job1')
  expect(j?.status).toBe('active')
  expect(listJobs().some((x) => x.id === 'job1')).toBe(true)
})

test('steps are ordered and nextPending returns the earliest pending', () => {
  newJob('job2')
  addStep({ jobId: 'job2', parentId: null, ord: 0, kind: 'outline', title: 's0', input: '{}' })
  addStep({ jobId: 'job2', parentId: null, ord: 1, kind: 'draft', title: 's1', input: '{}' })
  addStep({ jobId: 'job2', parentId: null, ord: 2, kind: 'edit', title: 's2', input: '{}' })
  expect(steps('job2').map((s) => s.ord)).toEqual([0, 1, 2])
  expect(nextPending('job2')?.ord).toBe(0)
})

test('completing a step advances nextPending and progress', () => {
  newJob('job3')
  const aId = addStep({ jobId: 'job3', parentId: null, ord: 0, kind: 'k', title: 'a', input: '{}' })
  addStep({ jobId: 'job3', parentId: null, ord: 1, kind: 'k', title: 'b', input: '{}' })
  updateStep(aId, { status: 'done', output: 'result' })
  expect(nextPending('job3')?.ord).toBe(1)
  const p = progress('job3')
  expect(p.total).toBe(2)
  expect(p.done).toBe(1)
})

test('reclaimRunning resets crashed steps to pending (resumability)', () => {
  newJob('job4')
  const sId = addStep({ jobId: 'job4', parentId: null, ord: 0, kind: 'k', title: 'a', input: '{}' })
  // Simulate a crash mid-step: it was left 'running'.
  updateStep(sId, { status: 'running' })
  expect(nextPending('job4') ?? null).toBeNull()   // nothing pending while it's 'running'
  const reclaimed = reclaimRunning('job4')
  expect(reclaimed).toBeGreaterThanOrEqual(1)
  expect(nextPending('job4')?.id).toBe(sId)      // now resumable
})
