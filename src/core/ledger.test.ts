import { test, expect, beforeAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// Point the ledger at a throwaway DB. Read lazily on first call, so setting it
// here (before any ledger function runs) is enough.
process.env.ZEUS_LEDGER = resolve(tmpdir(), `zeus-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)

import { record, recentRemote, totalSpend, summary } from './ledger.ts'

function entry(over: Partial<Parameters<typeof record>[0]> = {}) {
  return {
    brainId: 'brain-x',
    endpoint: 'https://api.example.com/v1/chat',
    locality: 'remote' as const,
    kind: 'chat',
    bytesSent: 100,
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.01,
    durationMs: 50,
    ok: true,
    ...over,
  }
}

beforeAll(() => {
  record(entry())
  record(entry({ costUsd: 0.02 }))
  record(entry({ locality: 'local', endpoint: 'http://localhost:11434/api', costUsd: 0 }))
})

test('records remote calls and lists them', () => {
  const remote = recentRemote(50)
  expect(remote.length).toBeGreaterThanOrEqual(2)
  expect(remote.every((e) => e.locality === 'remote')).toBe(true)
})

test('a local call is not counted as egress', () => {
  // The trust feature: only calls that left the machine show as remote egress.
  const remote = recentRemote(50)
  expect(remote.some((e) => e.locality === 'local')).toBe(false)
})

test('totalSpend sums recorded cost', () => {
  // 0.01 + 0.02 + 0 (local) = 0.03
  expect(totalSpend()).toBeCloseTo(0.03, 6)
})

test('summary groups egress without throwing', () => {
  const s = summary()
  expect(Array.isArray(s)).toBe(true)
})
