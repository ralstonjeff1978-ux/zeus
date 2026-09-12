import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { zeusHome } from '../core/ledger.ts'
import type { AcceptanceCheck } from './acceptance.ts'

/**
 * Durable job storage.
 *
 * A job is work too large to finish in one conversation: a design that must be
 * decomposed, critiqued and revised, or a manuscript of hundreds of sections.
 * It lives on disk as a tree of steps so it survives a crash, a reboot, or a
 * week away, and resumes exactly where it stopped.
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type Job = {
  id: string
  kind: string
  title: string
  goal: string
  status: 'active' | 'done' | 'failed' | 'paused'
  createdAt: string
  updatedAt: string
  /** JSON blob of job-wide state — an outline, a design brief, a story bible. */
  state: string
  workdir: string
}

export type Step = {
  id: number
  jobId: string
  parentId: number | null
  ord: number
  kind: string
  title: string
  status: StepStatus
  /** JSON input the step needs. */
  input: string
  /** The step's produced content. */
  output: string | null
  error: string | null
  attempts: number
  brainId: string | null
  costUsd: number
  /**
   * An optional acceptance gate, stored as a JSON `AcceptanceCheck`. When set,
   * the engine runs it after the step's handler and only marks the step `done`
   * if it passes; a failure feeds the retry/resume path. Null means no gate.
   */
  acceptance: string | null
  updatedAt: string
}

export function jobsDbPath(): string {
  return process.env.ZEUS_JOBS ?? resolve(zeusHome(), 'jobs.sqlite')
}

let db: Database | undefined

export function jobsDb(): Database {
  if (db) return db
  db = new Database(jobsDbPath(), { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      goal       TEXT NOT NULL,
      status     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT '{}',
      workdir    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      parent_id  INTEGER,
      ord        INTEGER NOT NULL DEFAULT 0,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      input      TEXT NOT NULL DEFAULT '{}',
      output     TEXT,
      error      TEXT,
      attempts   INTEGER NOT NULL DEFAULT 0,
      brain_id   TEXT,
      cost_usd   REAL NOT NULL DEFAULT 0,
      acceptance TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS steps_job    ON steps(job_id, ord);
    CREATE INDEX IF NOT EXISTS steps_status ON steps(job_id, status);
  `)
  // Additive migration: a database created before acceptance gates existed has
  // no `acceptance` column. Add it in place; existing rows read as NULL (no gate).
  const cols = new Set(
    (db.query(`PRAGMA table_info(steps)`).all() as Array<{ name: string }>).map(c => c.name),
  )
  if (!cols.has('acceptance')) db.exec(`ALTER TABLE steps ADD COLUMN acceptance TEXT`)
  return db
}

const now = () => new Date().toISOString()

export function createJob(j: Omit<Job, 'createdAt' | 'updatedAt' | 'status'> & { status?: Job['status'] }): Job {
  const d = jobsDb()
  const ts = now()
  d.query(
    `INSERT INTO jobs (id, kind, title, goal, status, created_at, updated_at, state, workdir)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(j.id, j.kind, j.title, j.goal, j.status ?? 'active', ts, ts, j.state, j.workdir)
  return { ...j, status: j.status ?? 'active', createdAt: ts, updatedAt: ts }
}

export function getJob(id: string): Job | undefined {
  return jobsDb()
    .query(
      `SELECT id, kind, title, goal, status, created_at AS createdAt,
              updated_at AS updatedAt, state, workdir FROM jobs WHERE id = ?`,
    )
    .get(id) as Job | undefined
}

export function listJobs(): Job[] {
  return jobsDb()
    .query(
      `SELECT id, kind, title, goal, status, created_at AS createdAt,
              updated_at AS updatedAt, state, workdir FROM jobs ORDER BY created_at DESC`,
    )
    .all() as Job[]
}

export function updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'state' | 'title'>>): void {
  const d = jobsDb()
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status))
  if (patch.state !== undefined) (sets.push('state = ?'), vals.push(patch.state))
  if (patch.title !== undefined) (sets.push('title = ?'), vals.push(patch.title))
  if (!sets.length) return
  sets.push('updated_at = ?')
  vals.push(now(), id)
  d.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]))
}

export function addStep(s: {
  jobId: string
  parentId?: number | null
  ord?: number
  kind: string
  title: string
  input?: unknown
  /** Optional acceptance gate run after the step's handler; see `Step.acceptance`. */
  acceptance?: AcceptanceCheck | null
}): number {
  const d = jobsDb()
  const res = d
    .query(
      `INSERT INTO steps (job_id, parent_id, ord, kind, title, input, acceptance, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      s.jobId,
      s.parentId ?? null,
      s.ord ?? 0,
      s.kind,
      s.title,
      JSON.stringify(s.input ?? {}),
      s.acceptance ? JSON.stringify(s.acceptance) : null,
      now(),
    )
  return Number(res.lastInsertRowid)
}

export function updateStep(
  id: number,
  patch: Partial<Pick<Step, 'status' | 'output' | 'error' | 'brainId' | 'costUsd'>> & {
    bumpAttempts?: boolean
  },
): void {
  const d = jobsDb()
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status))
  if (patch.output !== undefined) (sets.push('output = ?'), vals.push(patch.output))
  if (patch.error !== undefined) (sets.push('error = ?'), vals.push(patch.error))
  if (patch.brainId !== undefined) (sets.push('brain_id = ?'), vals.push(patch.brainId))
  if (patch.costUsd !== undefined) (sets.push('cost_usd = cost_usd + ?'), vals.push(patch.costUsd))
  if (patch.bumpAttempts) sets.push('attempts = attempts + 1')
  sets.push('updated_at = ?')
  vals.push(now(), id)
  d.query(`UPDATE steps SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]))
}

const STEP_COLS = `id, job_id AS jobId, parent_id AS parentId, ord, kind, title, status,
                   input, output, error, attempts, brain_id AS brainId,
                   cost_usd AS costUsd, acceptance, updated_at AS updatedAt`

export function steps(jobId: string): Step[] {
  return jobsDb().query(`SELECT ${STEP_COLS} FROM steps WHERE job_id = ? ORDER BY ord, id`).all(jobId) as Step[]
}

/** The next step to run: first pending step in order. */
export function nextPending(jobId: string): Step | undefined {
  return jobsDb()
    .query(`SELECT ${STEP_COLS} FROM steps WHERE job_id = ? AND status = 'pending' ORDER BY ord, id LIMIT 1`)
    .get(jobId) as Step | undefined
}

export function stepById(id: number): Step | undefined {
  return jobsDb().query(`SELECT ${STEP_COLS} FROM steps WHERE id = ?`).get(id) as Step | undefined
}

export function progress(jobId: string): { done: number; total: number; failed: number; costUsd: number } {
  const row = jobsDb()
    .query(
      `SELECT
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)   AS done,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS total,
         COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM steps WHERE job_id = ?`,
    )
    .get(jobId) as { done: number; failed: number; total: number; costUsd: number }
  return { done: row.done ?? 0, failed: row.failed ?? 0, total: row.total ?? 0, costUsd: row.costUsd ?? 0 }
}

/** Reset steps left mid-flight by a crash so a resume can pick them up. */
export function reclaimRunning(jobId: string): number {
  const res = jobsDb()
    .query(`UPDATE steps SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'running'`)
    .run(now(), jobId)
  return res.changes
}
