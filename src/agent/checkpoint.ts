import { Database } from 'bun:sqlite'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { zeusHome } from '../core/ledger.ts'

/**
 * Checkpoints.
 *
 * An agent run edits real files. Before it starts, Zeus snapshots the files it
 * is about to be able to touch, so a run that goes wrong can be undone in one
 * command rather than reconstructed from memory.
 *
 * Snapshots are content-addressed and stored locally. Only text files under a
 * size ceiling are captured — this is an undo for source edits, not a backup
 * system, and it says so rather than pretending otherwise.
 */

const MAX_FILE_BYTES = 2_000_000

let db: Database | undefined

function open(): Database {
  if (db) return db
  db = new Database(resolve(zeusHome(), 'checkpoints.sqlite'), { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      root       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      files      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      checkpoint TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      existed    INTEGER NOT NULL,
      content    TEXT,
      PRIMARY KEY (checkpoint, path)
    );
  `)
  return db
}

/** Capture the current state of every text file under `root`. */
export async function createCheckpoint(root: string, label: string): Promise<{ id: string; files: number }> {
  const d = open()
  const id = `ck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const abs = resolve(root)

  const glob = new Bun.Glob('**/*')
  const insert = d.query('INSERT OR REPLACE INTO snapshots (checkpoint, path, existed, content) VALUES (?,?,?,?)')
  let count = 0

  d.query('INSERT INTO checkpoints (id, label, root, created_at, files) VALUES (?,?,?,?,0)').run(
    id,
    label,
    abs,
    new Date().toISOString(),
  )

  for await (const rel of glob.scan({ cwd: abs, onlyFiles: true, dot: false })) {
    if (/[\\/](node_modules|\.git|dist|build|__pycache__|\.zeus)[\\/]/.test(rel) || rel.startsWith('.git')) continue
    const file = resolve(abs, rel)
    try {
      const stat = await Bun.file(file).size
      if (stat > MAX_FILE_BYTES) continue
      const text = await readFile(file, 'utf8')
      insert.run(id, rel, 1, text)
      count++
    } catch {
      // Binary or unreadable — skip it. Restore will not touch what it never captured.
    }
    if (count >= 5000) break
  }

  d.query('UPDATE checkpoints SET files = ? WHERE id = ?').run(count, id)
  return { id, files: count }
}

export type CheckpointInfo = { id: string; label: string; root: string; createdAt: string; files: number }

export function listCheckpoints(): CheckpointInfo[] {
  return open()
    .query('SELECT id, label, root, created_at AS createdAt, files FROM checkpoints ORDER BY created_at DESC LIMIT 50')
    .all() as CheckpointInfo[]
}

/** What changed since a checkpoint was taken. */
export async function diffCheckpoint(id: string): Promise<{ changed: string[]; added: string[]; deleted: string[] }> {
  const d = open()
  const ck = d.query('SELECT root FROM checkpoints WHERE id = ?').get(id) as { root: string } | undefined
  if (!ck) throw new Error(`No checkpoint "${id}".`)

  const rows = d.query('SELECT path, content FROM snapshots WHERE checkpoint = ?').all(id) as Array<{
    path: string
    content: string
  }>
  const snapshot = new Map(rows.map(r => [r.path, r.content]))

  const changed: string[] = []
  const deleted: string[] = []
  const added: string[] = []

  for (const [rel, content] of snapshot) {
    const file = resolve(ck.root, rel)
    if (!existsSync(file)) {
      deleted.push(rel)
      continue
    }
    try {
      if ((await readFile(file, 'utf8')) !== content) changed.push(rel)
    } catch {
      /* became binary or unreadable */
    }
  }

  const glob = new Bun.Glob('**/*')
  for await (const rel of glob.scan({ cwd: ck.root, onlyFiles: true, dot: false })) {
    if (/[\\/](node_modules|\.git|dist|build|__pycache__|\.zeus)[\\/]/.test(rel)) continue
    if (!snapshot.has(rel)) added.push(rel)
  }

  return { changed, added, deleted }
}

/**
 * Restore files to their checkpointed state.
 * Files created after the checkpoint are removed only when `removeAdded` is set,
 * because deleting something the user made deliberately is worse than leaving it.
 */
export async function restoreCheckpoint(id: string, removeAdded = false): Promise<{ restored: number; removed: number }> {
  const d = open()
  const ck = d.query('SELECT root FROM checkpoints WHERE id = ?').get(id) as { root: string } | undefined
  if (!ck) throw new Error(`No checkpoint "${id}".`)

  const rows = d.query('SELECT path, content FROM snapshots WHERE checkpoint = ?').all(id) as Array<{
    path: string
    content: string
  }>

  let restored = 0
  for (const r of rows) {
    const file = resolve(ck.root, r.path)
    let current: string | undefined
    try {
      current = existsSync(file) ? await readFile(file, 'utf8') : undefined
    } catch {
      current = undefined
    }
    if (current === r.content) continue
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, r.content, 'utf8')
    restored++
  }

  let removed = 0
  if (removeAdded) {
    const { added } = await diffCheckpoint(id)
    for (const rel of added) {
      await rm(resolve(ck.root, rel), { force: true })
      removed++
    }
  }

  return { restored, removed }
}

export function deleteCheckpoint(id: string): void {
  const d = open()
  d.query('DELETE FROM snapshots WHERE checkpoint = ?').run(id)
  d.query('DELETE FROM checkpoints WHERE id = ?').run(id)
}
