import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { type Tool, type ToolResult, ok, fail } from './types.ts'
import { zeusHome } from '../../core/ledger.ts'
import { loadRegistry } from '../../registry/registry.ts'
import { embedAdapterFor } from '../../adapters/index.ts'

/**
 * Persistent memory with semantic search.
 *
 * Facts a brain learns during one session are lost at the end of it, and a
 * long-running job cannot carry everything it knows in its context. Memory is
 * a local store, indexed by a local embedding brain, searched by meaning rather
 * than by keyword.
 *
 * Everything here stays on disk on this machine.
 */

let db: Database | undefined

function open(): Database {
  if (db) return db
  db = new Database(process.env.ZEUS_MEMORY ?? resolve(zeusHome(), 'memory.sqlite'), { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      scope     TEXT NOT NULL DEFAULT 'global',
      key       TEXT,
      content   TEXT NOT NULL,
      tags      TEXT NOT NULL DEFAULT '',
      vector    BLOB,
      dims      INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mem_scope ON memories(scope);
    CREATE UNIQUE INDEX IF NOT EXISTS mem_key ON memories(scope, key) WHERE key IS NOT NULL;
  `)
  return db
}

/** Find an embedding brain. Semantic search degrades to keyword without one. */
async function embedder() {
  const reg = await loadRegistry()
  const brain = reg.brains.find(b => b.kind === 'embed' && b.probed?.reachable !== false)
  if (!brain) return undefined
  try {
    return { brain, adapter: embedAdapterFor(brain) }
  } catch {
    return undefined
  }
}

async function embed(text: string): Promise<Float32Array | undefined> {
  const e = await embedder()
  if (!e) return undefined
  try {
    const res = await e.adapter.embed(e.brain, { input: [text.slice(0, 8000)] })
    const v = res.vectors[0]
    return v ? Float32Array.from(v) : undefined
  } catch {
    return undefined
  }
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(0))
}

function fromBlob(b: Uint8Array | null, dims: number | null): Float32Array | undefined {
  if (!b || !dims) return undefined
  return new Float32Array(b.buffer, b.byteOffset, dims)
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export const memoryWriteTool: Tool = {
  name: 'memory_write',
  description:
    'Save something worth remembering beyond this session — a decision and its reason, a hard-won fact about this project, a constraint. Give a key to make it updatable. Do not save what a file already says.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact, stated so it makes sense on its own later' },
      key: { type: 'string', description: 'Stable identifier; writing the same key again updates it' },
      scope: { type: 'string', description: 'Project or topic this belongs to. Defaults to "global".' },
      tags: { type: 'string', description: 'Comma-separated tags' },
    },
    required: ['content'],
  },
  async run(input: { content: string; key?: string; scope?: string; tags?: string }): Promise<ToolResult> {
    const d = open()
    const now = new Date().toISOString()
    const scope = input.scope ?? 'global'
    const vec = await embed(input.content)

    if (input.key) {
      const existing = d.query('SELECT id FROM memories WHERE scope = ? AND key = ?').get(scope, input.key) as
        | { id: number }
        | undefined
      if (existing) {
        d.query('UPDATE memories SET content = ?, tags = ?, vector = ?, dims = ?, updated_at = ? WHERE id = ?').run(
          input.content,
          input.tags ?? '',
          vec ? toBlob(vec) : null,
          vec?.length ?? null,
          now,
          existing.id,
        )
        return ok(`Updated memory "${input.key}" in ${scope}.`)
      }
    }

    d.query(
      'INSERT INTO memories (scope, key, content, tags, vector, dims, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(scope, input.key ?? null, input.content, input.tags ?? '', vec ? toBlob(vec) : null, vec?.length ?? null, now, now)

    return ok(
      `Saved to ${scope}${input.key ? ` as "${input.key}"` : ''}.` +
        (vec ? '' : ' (No embedding brain available, so this is keyword-searchable only.)'),
    )
  },
}

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description:
    'Search saved memories by meaning. Call this at the start of work on a project to recover what was previously established.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: { type: 'string', description: 'Restrict to one scope' },
      limit: { type: 'integer', description: 'Defaults to 8' },
    },
    required: ['query'],
  },
  async run(input: { query: string; scope?: string; limit?: number }): Promise<ToolResult> {
    const d = open()
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 40)
    const rows = d
      .query(
        `SELECT id, scope, key, content, tags, vector, dims, updated_at
           FROM memories ${input.scope ? 'WHERE scope = ?' : ''} ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(...(input.scope ? [input.scope] : [])) as Array<{
      id: number
      scope: string
      key: string | null
      content: string
      tags: string
      vector: Uint8Array | null
      dims: number | null
      updated_at: string
    }>

    if (!rows.length) return ok('Nothing saved yet.')

    const qv = await embed(input.query)
    let ranked: Array<{ row: (typeof rows)[number]; score: number }>

    if (qv) {
      ranked = rows
        .map(row => {
          const v = fromBlob(row.vector, row.dims)
          return { row, score: v ? cosine(qv, v) : 0 }
        })
        .filter(r => r.score > 0.2)
        .sort((a, b) => b.score - a.score)
    } else {
      // Without embeddings, fall back to term overlap rather than returning nothing.
      const terms = input.query.toLowerCase().split(/\W+/).filter(t => t.length > 2)
      ranked = rows
        .map(row => {
          const hay = (row.content + ' ' + row.tags + ' ' + (row.key ?? '')).toLowerCase()
          return { row, score: terms.filter(t => hay.includes(t)).length / Math.max(1, terms.length) }
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
    }

    if (!ranked.length) return ok(`No memory matches "${input.query}".`)

    return ok(
      ranked
        .slice(0, limit)
        .map(
          r =>
            `[${r.row.scope}${r.row.key ? `/${r.row.key}` : ''}] (${r.score.toFixed(2)})\n${r.row.content}`,
        )
        .join('\n\n'),
    )
  },
}

export const memoryListTool: Tool = {
  name: 'memory_list',
  description: 'List memory scopes and how many entries each holds.',
  mutates: false,
  parameters: { type: 'object', properties: {} },
  async run(): Promise<ToolResult> {
    const rows = open()
      .query('SELECT scope, COUNT(*) AS n, MAX(updated_at) AS last FROM memories GROUP BY scope ORDER BY n DESC')
      .all() as Array<{ scope: string; n: number; last: string }>
    if (!rows.length) return ok('No memories stored.')
    return ok(rows.map(r => `  ${r.scope.padEnd(24)} ${String(r.n).padStart(4)} entries   last ${r.last.slice(0, 10)}`).join('\n'))
  },
}

export const memoryForgetTool: Tool = {
  name: 'memory_forget',
  description: 'Delete a memory by scope and key. Use when something saved turns out to be wrong.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: { scope: { type: 'string' }, key: { type: 'string' } },
    required: ['scope', 'key'],
  },
  async run(input: { scope: string; key: string }): Promise<ToolResult> {
    const res = open().query('DELETE FROM memories WHERE scope = ? AND key = ?').run(input.scope, input.key)
    return res.changes ? ok(`Forgot "${input.key}".`) : fail(`No memory "${input.key}" in scope "${input.scope}".`)
  },
}

export const memoryTools: Tool[] = [memoryWriteTool, memorySearchTool, memoryListTool, memoryForgetTool]
