import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Brain } from '../registry/schema.ts'
import type { Usage } from '../adapters/types.ts'

/**
 * The egress ledger.
 *
 * Every call Zeus makes to a brain is recorded here, with an explicit note of
 * whether it left the machine. Zeus never blocks a remote call — it records it,
 * so the record can be audited afterwards rather than trusted in advance.
 *
 * This is a local SQLite file. It is never transmitted anywhere.
 */

export type LedgerEntry = {
  id?: number
  ts: string
  brainId: string
  endpoint: string
  host: string
  locality: 'local' | 'remote'
  kind: string
  /** Bytes of prompt payload sent on the wire. */
  bytesSent: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  durationMs: number
  ok: boolean
  error?: string
  /** Free-form label so a call can be traced to the job or session that caused it. */
  context?: string
}

export function ledgerPath(): string {
  return process.env.ZEUS_LEDGER ?? resolve(zeusHome(), 'ledger.sqlite')
}

export function zeusHome(): string {
  const home = process.env.ZEUS_HOME ?? resolve(process.cwd(), '.zeus')
  if (!existsSync(home)) mkdirSync(home, { recursive: true })
  return home
}

let db: Database | undefined

function open(): Database {
  if (db) return db
  const path = ledgerPath()
  mkdirSync(dirname(path), { recursive: true })
  db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS egress (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL,
      brain_id     TEXT    NOT NULL,
      endpoint     TEXT    NOT NULL,
      host         TEXT    NOT NULL,
      locality     TEXT    NOT NULL,
      kind         TEXT    NOT NULL,
      bytes_sent   INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd     REAL    NOT NULL DEFAULT 0,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      ok           INTEGER NOT NULL DEFAULT 1,
      error        TEXT,
      context      TEXT
    );
    CREATE INDEX IF NOT EXISTS egress_ts       ON egress(ts);
    CREATE INDEX IF NOT EXISTS egress_locality ON egress(locality);
    CREATE INDEX IF NOT EXISTS egress_brain    ON egress(brain_id);
  `)
  return db
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

export function record(entry: Omit<LedgerEntry, 'id' | 'ts' | 'host'> & { ts?: string }): void {
  const d = open()
  d.query(
    `INSERT INTO egress
       (ts, brain_id, endpoint, host, locality, kind, bytes_sent, input_tokens,
        output_tokens, cost_usd, duration_ms, ok, error, context)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    entry.ts ?? new Date().toISOString(),
    entry.brainId,
    entry.endpoint,
    hostOf(entry.endpoint),
    entry.locality,
    entry.kind,
    entry.bytesSent,
    entry.inputTokens,
    entry.outputTokens,
    entry.costUsd,
    entry.durationMs,
    entry.ok ? 1 : 0,
    entry.error ?? null,
    entry.context ?? null,
  )
}

/** Convenience wrapper used by the router around every brain call. */
export function recordCall(
  brain: Brain,
  opts: {
    bytesSent: number
    usage: Usage
    durationMs: number
    ok: boolean
    error?: string
    context?: string
  },
): void {
  record({
    brainId: brain.id,
    endpoint: brain.endpoint,
    locality: brain.locality,
    kind: brain.kind,
    bytesSent: opts.bytesSent,
    inputTokens: opts.usage.inputTokens ?? 0,
    outputTokens: opts.usage.outputTokens ?? 0,
    costUsd: opts.usage.costUsd ?? 0,
    durationMs: opts.durationMs,
    ok: opts.ok,
    error: opts.error,
    context: opts.context,
  })
}

export type EgressSummary = {
  host: string
  locality: string
  calls: number
  bytesSent: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  lastAt: string
}

export function summary(sinceIso?: string): EgressSummary[] {
  const d = open()
  const where = sinceIso ? 'WHERE ts >= ?' : ''
  const rows = d
    .query(
      `SELECT host, locality,
              COUNT(*)            AS calls,
              SUM(bytes_sent)     AS bytesSent,
              SUM(input_tokens)   AS inputTokens,
              SUM(output_tokens)  AS outputTokens,
              SUM(cost_usd)       AS costUsd,
              MAX(ts)             AS lastAt
         FROM egress ${where}
        GROUP BY host, locality
        ORDER BY locality DESC, costUsd DESC`,
    )
    .all(...(sinceIso ? [sinceIso] : [])) as EgressSummary[]
  return rows
}

export function recentRemote(limit = 50): LedgerEntry[] {
  const d = open()
  return d
    .query(
      `SELECT id, ts, brain_id AS brainId, endpoint, host, locality, kind,
              bytes_sent AS bytesSent, input_tokens AS inputTokens,
              output_tokens AS outputTokens, cost_usd AS costUsd,
              duration_ms AS durationMs, ok, error, context
         FROM egress
        WHERE locality = 'remote'
        ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as LedgerEntry[]
}

export function totalSpend(sinceIso?: string): number {
  const d = open()
  const where = sinceIso ? 'WHERE ts >= ?' : ''
  const row = d.query(`SELECT COALESCE(SUM(cost_usd),0) AS t FROM egress ${where}`).get(
    ...(sinceIso ? [sinceIso] : []),
  ) as { t: number }
  return row.t
}

export function closeLedger(): void {
  db?.close()
  db = undefined
}
