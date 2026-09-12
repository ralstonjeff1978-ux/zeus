import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { resolve, sep, extname } from 'node:path'
import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * Structured data tools.
 *
 * Reading a CSV by shelling out to a text tool loses the structure that made it
 * a CSV. These tools keep it, and give the brain data it can actually reason
 * over rather than a wall of text.
 */

function contain(pathArg: string, ctx: ToolContext): string {
  const abs = resolve(ctx.cwd, pathArg)
  const inside = ctx.allowedRoots.some(r => {
    const root = resolve(r)
    return abs === root || abs.startsWith(root + sep)
  })
  if (!inside) throw new Error(`"${pathArg}" is outside the allowed roots.`)
  return abs
}

/** Statements that only read. Anything else needs approval. */
const READ_ONLY_SQL = /^\s*(SELECT|WITH|EXPLAIN|PRAGMA\s+table_info|PRAGMA\s+table_list)\b/i

export const sqliteTool: Tool = {
  name: 'sqlite',
  description:
    'Query a SQLite database. SELECT and other read-only statements run directly; anything that writes asks first. Returns rows as a table.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .sqlite/.db file' },
      sql: { type: 'string' },
      params: { type: 'array', items: {}, description: 'Bound parameters for ? placeholders' },
      limit: { type: 'integer', description: 'Max rows returned. Defaults to 200.' },
    },
    required: ['path', 'sql'],
  },
  async run(input: { path: string; sql: string; params?: unknown[]; limit?: number }, ctx): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    if (!existsSync(abs)) return fail(`No such database: ${input.path}`)

    const readOnly = READ_ONLY_SQL.test(input.sql)
    if (!readOnly && !(await ctx.confirm('Modify database', `${input.path}\n  ${input.sql.slice(0, 300)}`))) {
      return fail('Denied by user.')
    }

    let d: Database
    try {
      d = new Database(abs, { readonly: readOnly })
    } catch (e) {
      return fail(`Cannot open ${input.path}: ${(e as Error).message}`)
    }

    try {
      const q = d.query(input.sql)
      if (!readOnly) {
        const res = q.run(...((input.params ?? []) as any[]))
        return ok(`Done. ${res.changes} row(s) changed.`)
      }

      const limit = Math.min(Math.max(input.limit ?? 200, 1), 2000)
      const rows = q.all(...((input.params ?? []) as any[])) as Record<string, unknown>[]
      if (!rows.length) return ok('(no rows)')

      const cols = Object.keys(rows[0]!)
      const shown = rows.slice(0, limit)
      const widths = cols.map(c =>
        Math.min(40, Math.max(c.length, ...shown.map(r => String(r[c] ?? '').length))),
      )
      const line = (cells: string[]) =>
        cells.map((v, i) => v.slice(0, widths[i]!).padEnd(widths[i]!)).join('  ')

      const body = [
        line(cols),
        widths.map(w => '─'.repeat(w)).join('  '),
        ...shown.map(r => line(cols.map(c => String(r[c] ?? '')))),
      ].join('\n')

      const more = rows.length > shown.length ? `\n... ${rows.length - shown.length} more rows` : ''
      return ok(body + more, `${rows.length} rows`)
    } catch (e) {
      return fail(`SQL error: ${(e as Error).message}`)
    } finally {
      d.close()
    }
  },
}

/** A CSV parser that respects quoting — the naive split loses data on real files. */
function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => r.length > 1 || r[0] !== '')
}

export const readDataTool: Tool = {
  name: 'read_data',
  description:
    'Read a structured data file — CSV, TSV, JSON or JSONL — and return it as a table with a summary of its shape. Use instead of read_file for data.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer', description: 'Rows to show. Defaults to 50.' },
      columns: { type: 'array', items: { type: 'string' }, description: 'Only these columns' },
    },
    required: ['path'],
  },
  async run(input: { path: string; limit?: number; columns?: string[] }, ctx): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    if (!existsSync(abs)) return fail(`No such file: ${input.path}`)
    const text = await Bun.file(abs).text()
    const ext = extname(abs).toLowerCase()
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)

    let header: string[]
    let rows: string[][]

    if (ext === '.json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (e) {
        return fail(`Not valid JSON: ${(e as Error).message}`)
      }
      if (!Array.isArray(parsed)) {
        return ok(JSON.stringify(parsed, null, 2).slice(0, 60_000))
      }
      const objs = parsed as Record<string, unknown>[]
      header = [...new Set(objs.flatMap(o => Object.keys(o ?? {})))]
      rows = objs.map(o => header.map(h => String(o?.[h] ?? '')))
    } else if (ext === '.jsonl' || ext === '.ndjson') {
      const objs = text
        .split('\n')
        .filter(l => l.trim())
        .map(l => {
          try {
            return JSON.parse(l)
          } catch {
            return {}
          }
        })
      header = [...new Set(objs.flatMap(o => Object.keys(o ?? {})))]
      rows = objs.map(o => header.map(h => String(o?.[h] ?? '')))
    } else {
      const parsed = parseCsv(text, ext === '.tsv' ? '\t' : ',')
      if (!parsed.length) return ok('(empty file)')
      header = parsed[0]!
      rows = parsed.slice(1)
    }

    let cols = header
    let data = rows
    if (input.columns?.length) {
      const idx = input.columns.map(c => header.indexOf(c)).filter(i => i >= 0)
      if (!idx.length) return fail(`None of those columns exist. Available: ${header.join(', ')}`)
      cols = idx.map(i => header[i]!)
      data = rows.map(r => idx.map(i => r[i] ?? ''))
    }

    const shown = data.slice(0, limit)
    const widths = cols.map((c, i) =>
      Math.min(32, Math.max(c.length, ...shown.map(r => (r[i] ?? '').length))),
    )
    const line = (cells: string[]) => cells.map((v, i) => v.slice(0, widths[i]!).padEnd(widths[i]!)).join('  ')

    const body = [
      line(cols),
      widths.map(w => '─'.repeat(w)).join('  '),
      ...shown.map(line),
    ].join('\n')

    const summary = `${data.length} rows × ${cols.length} columns${data.length > shown.length ? ` (showing ${shown.length})` : ''}`
    return ok(`${summary}\n\n${body}`)
  },
}

export const httpTool: Tool = {
  name: 'http_request',
  description:
    'Make an HTTP request to an API and return the response. Use for querying services, checking endpoints and testing what you have built.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      headers: { type: 'object', description: 'Header name/value pairs' },
      body: { type: 'string', description: 'Request body, already serialised' },
      timeout_ms: { type: 'integer' },
    },
    required: ['url'],
  },
  async run(
    input: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeout_ms?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    let url: URL
    try {
      url = new URL(input.url)
    } catch {
      return fail(`"${input.url}" is not a valid URL.`)
    }
    const method = (input.method ?? 'GET').toUpperCase()

    // Loopback is the agent testing its own work; anything else leaves the machine.
    const isLocal = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)
    if (!isLocal || method !== 'GET') {
      if (!(await ctx.confirm(`HTTP ${method}`, url.href))) return fail('Denied by user.')
    }

    try {
      const res = await fetch(url.href, {
        method,
        headers: input.headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : input.body,
        signal: AbortSignal.timeout(Math.min(input.timeout_ms ?? 60_000, 300_000)),
      })
      const text = await res.text()
      const head = [...res.headers.entries()]
        .filter(([k]) => ['content-type', 'content-length', 'location', 'retry-after'].includes(k))
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')
      return {
        content: `HTTP ${res.status} ${res.statusText}\n${head}\n\n${text.slice(0, 60_000)}`,
        isError: !res.ok,
      }
    } catch (e) {
      return fail(`Request failed: ${(e as Error).message}`)
    }
  },
}

export const dataTools: Tool[] = [sqliteTool, readDataTool, httpTool]
