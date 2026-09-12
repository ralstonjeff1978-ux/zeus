import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, relative, dirname, sep, join } from 'node:path'
import { Glob } from 'bun'
import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * Filesystem tools.
 *
 * Every path argument is resolved and then checked against the agent's allowed
 * roots. Containment is enforced here rather than in the prompt, because a
 * prompt is a request and this is a boundary.
 */

const MAX_READ_BYTES = 400_000
const MAX_MATCHES = 250

function contain(pathArg: string, ctx: ToolContext): string {
  const abs = resolve(ctx.cwd, pathArg)
  const inside = ctx.allowedRoots.some(root => {
    const r = resolve(root)
    return abs === r || abs.startsWith(r + sep)
  })
  if (!inside) {
    throw new Error(
      `Path "${pathArg}" resolves outside the allowed roots (${ctx.allowedRoots.join(', ')}).`,
    )
  }
  return abs
}

function rel(abs: string, ctx: ToolContext): string {
  const r = relative(ctx.cwd, abs)
  return r.startsWith('..') ? abs : r || '.'
}

export const readTool: Tool = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file. Returns numbered lines. Use offset/limit for large files rather than reading everything.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to cwd' },
      offset: { type: 'integer', description: 'First line to return (1-based)' },
      limit: { type: 'integer', description: 'How many lines to return' },
    },
    required: ['path'],
  },
  async run(input: { path: string; offset?: number; limit?: number }, ctx): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    if (!existsSync(abs)) return fail(`No such file: ${input.path}`)

    const info = await stat(abs)
    if (info.isDirectory()) return fail(`${input.path} is a directory. Use list_dir.`)
    if (info.size > MAX_READ_BYTES && !input.limit) {
      return fail(
        `${input.path} is ${(info.size / 1024).toFixed(0)}KB, over the ${MAX_READ_BYTES / 1024}KB limit. Pass offset and limit.`,
      )
    }

    const text = await readFile(abs, 'utf8')
    const lines = text.split('\n')
    const start = Math.max(0, (input.offset ?? 1) - 1)
    const end = input.limit ? start + input.limit : lines.length
    const slice = lines.slice(start, end)
    const width = String(start + slice.length).length

    const body = slice.map((l, i) => `${String(start + i + 1).padStart(width)}  ${l}`).join('\n')
    const more = end < lines.length ? `\n... ${lines.length - end} more lines` : ''
    return ok(body + more, `read ${rel(abs, ctx)} (${slice.length} lines)`)
  },
}

export const writeTool: Tool = {
  name: 'write_file',
  description:
    'Write a file, creating parent directories as needed. Overwrites existing content — read the file first if you mean to preserve any of it.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async run(input: { path: string; content: string }, ctx): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    const existed = existsSync(abs)
    const verb = existed ? 'Overwrite' : 'Create'
    if (!(await ctx.confirm(`${verb} file`, rel(abs, ctx)))) return fail('Denied by user.')

    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')

    // An empty write is almost always a malformed tool call rather than an
    // intention, and reporting it as a plain success is how an agent ends up
    // believing it wrote a program it did not write. Say so, and say it as an
    // error, so the model gets a signal it can act on instead of moving on.
    if (!input.content.trim()) {
      return {
        content:
          `${rel(abs, ctx)} was written with no content — the "content" argument was empty. ` +
          `The file now exists but is blank. If you meant to write something, call write_file ` +
          `again with the full text in "content".`,
        isError: true,
      }
    }

    const lines = input.content.split('\n').length
    return ok(`${existed ? 'Overwrote' : 'Created'} ${rel(abs, ctx)} (${lines} lines)`)
  },
}

export const editTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. The old string must appear exactly once unless replace_all is true. Prefer this over rewriting a whole file.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to find, including indentation' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(
    input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
    ctx,
  ): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    if (!existsSync(abs)) {
      return fail(`No such file: ${input.path}. To create a new file, use write_file instead of edit_file.`)
    }
    if (input.old_string === input.new_string) return fail('old_string and new_string are identical.')

    const before = await readFile(abs, 'utf8')
    const count = before.split(input.old_string).length - 1
    if (count === 0) {
      return fail(
        `old_string not found in ${input.path}. It must match exactly, including whitespace and indentation.`,
      )
    }
    if (count > 1 && !input.replace_all) {
      return fail(
        `old_string appears ${count} times in ${input.path}. Add more surrounding context to make it unique, or set replace_all.`,
      )
    }

    if (!(await ctx.confirm('Edit file', `${rel(abs, ctx)} (${count} replacement${count > 1 ? 's' : ''})`))) {
      return fail('Denied by user.')
    }

    const after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, input.new_string)
    await writeFile(abs, after, 'utf8')
    return ok(`Edited ${rel(abs, ctx)} — ${count} replacement${count > 1 ? 's' : ''}.`)
  },
}

export const listTool: Tool = {
  name: 'list_dir',
  description: 'List the entries of a directory, marking which are directories.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Defaults to cwd' } },
  },
  async run(input: { path?: string }, ctx): Promise<ToolResult> {
    const abs = contain(input.path ?? '.', ctx)
    if (!existsSync(abs)) return fail(`No such directory: ${input.path ?? '.'}`)
    const entries = await readdir(abs, { withFileTypes: true })
    if (!entries.length) return ok('(empty)')
    const body = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .join('\n')
    return ok(body, `list ${rel(abs, ctx)} (${entries.length})`)
  },
}

export const globTool: Tool = {
  name: 'find_files',
  description:
    'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Returns paths, most recently modified first.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search from. Defaults to cwd.' },
    },
    required: ['pattern'],
  },
  async run(input: { pattern: string; path?: string }, ctx): Promise<ToolResult> {
    const root = contain(input.path ?? '.', ctx)
    const glob = new Glob(input.pattern)
    const hits: Array<{ p: string; m: number }> = []

    for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
      const abs = join(root, file)
      if (/[\\/](node_modules|\.git|dist|build|__pycache__)[\\/]/.test(abs)) continue
      try {
        hits.push({ p: abs, m: (await stat(abs)).mtimeMs })
      } catch {
        /* vanished between scan and stat */
      }
      if (hits.length >= MAX_MATCHES * 4) break
    }

    if (!hits.length) return ok(`No files match ${input.pattern}`)
    hits.sort((a, b) => b.m - a.m)
    const shown = hits.slice(0, MAX_MATCHES)
    const more = hits.length > shown.length ? `\n... ${hits.length - shown.length} more` : ''
    return ok(shown.map(h => rel(h.p, ctx)).join('\n') + more, `${hits.length} files`)
  },
}

export const grepTool: Tool = {
  name: 'search_text',
  description:
    'Search file contents with a regular expression. Returns matching lines with their file and line number.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression' },
      path: { type: 'string', description: 'Directory to search. Defaults to cwd.' },
      glob: { type: 'string', description: 'Restrict to files matching this glob, e.g. "**/*.ts"' },
      ignore_case: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  async run(
    input: { pattern: string; path?: string; glob?: string; ignore_case?: boolean },
    ctx,
  ): Promise<ToolResult> {
    const root = contain(input.path ?? '.', ctx)
    let re: RegExp
    try {
      re = new RegExp(input.pattern, input.ignore_case ? 'i' : '')
    } catch (e) {
      return fail(`Invalid regular expression: ${(e as Error).message}`)
    }

    const glob = new Glob(input.glob ?? '**/*')
    const out: string[] = []
    let scanned = 0

    for await (const file of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
      const abs = join(root, file)
      if (/[\\/](node_modules|\.git|dist|build|__pycache__)[\\/]/.test(abs)) continue
      if (out.length >= MAX_MATCHES) break
      try {
        const info = await stat(abs)
        if (info.size > MAX_READ_BYTES) continue
        const text = await readFile(abs, 'utf8')
        scanned++
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
          if (re.test(lines[i]!)) out.push(`${rel(abs, ctx)}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`)
        }
      } catch {
        /* binary or unreadable */
      }
    }

    if (!out.length) return ok(`No matches for /${input.pattern}/ in ${scanned} files.`)
    return ok(out.join('\n'), `${out.length} matches in ${scanned} files`)
  },
}

export const fileTools: Tool[] = [readTool, writeTool, editTool, listTool, globTool, grepTool]
