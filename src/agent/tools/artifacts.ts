import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname, sep, extname } from 'node:path'
import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * Artifact tools.
 *
 * A PDF is not a brain — it is a rendering. These tools turn generated content
 * into the file the user actually asked for, without an AI in the loop.
 */

function contain(pathArg: string, ctx: ToolContext): string {
  const abs = resolve(ctx.cwd, pathArg)
  const inside = ctx.allowedRoots.some(root => {
    const r = resolve(root)
    return abs === r || abs.startsWith(r + sep)
  })
  if (!inside) throw new Error(`Path "${pathArg}" is outside the allowed roots.`)
  return abs
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * A deliberately small Markdown renderer.
 *
 * Zeus produces documents constantly, and taking a Markdown dependency for
 * headings, lists and code fences is not worth the supply chain. This covers
 * what generated documents actually contain.
 */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false
  let listType: 'ul' | 'ol' | undefined

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = undefined
    }
  }

  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')

    if (/^```/.test(line)) {
      closeList()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(escapeHtml(line))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1]!.length
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      if (listType !== 'ul') {
        closeList()
        out.push('<ul>')
        listType = 'ul'
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`)
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (listType !== 'ol') {
        closeList()
        out.push('<ol>')
        listType = 'ol'
      }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`)
      continue
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      closeList()
      out.push('<hr>')
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`)
      continue
    }
    if (line.trim() === '') {
      closeList()
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inCode) out.push('</code></pre>')
  closeList()
  return out.join('\n')
}

const PRINT_CSS = `
  @page { size: Letter; margin: 22mm 18mm; }
  body { font: 11.5pt/1.55 Georgia, 'Times New Roman', serif; color: #111; max-width: 46em; margin: 0 auto; }
  h1 { font-size: 2em; margin: 0 0 .4em; page-break-after: avoid; }
  h2 { font-size: 1.45em; margin: 1.6em 0 .4em; page-break-after: avoid; border-bottom: 1px solid #ddd; padding-bottom: .2em; }
  h3 { font-size: 1.15em; margin: 1.3em 0 .3em; page-break-after: avoid; }
  p { margin: 0 0 .8em; orphans: 3; widows: 3; }
  code { font: .9em/1.4 Consolas, 'Courier New', monospace; background: #f4f4f4; padding: .1em .3em; border-radius: 3px; }
  pre { background: #f7f7f7; border: 1px solid #e3e3e3; border-radius: 5px; padding: .8em 1em; overflow-x: auto; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 0 0 .8em; padding-left: 1em; border-left: 3px solid #ccc; color: #444; }
  hr { border: 0; border-top: 1px solid #ddd; margin: 2em 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1em; }
  th, td { border: 1px solid #ccc; padding: .4em .6em; text-align: left; }
  @media screen { body { padding: 2em 1em; } }
`

export function wrapHtmlDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}

export const documentTool: Tool = {
  name: 'make_document',
  description:
    'Render Markdown into a finished document. format "html" always works. format "pdf" additionally needs a headless Chrome or Edge on the machine; if none is found the HTML is written and the reason reported.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Output path, e.g. report.pdf' },
      title: { type: 'string' },
      markdown: { type: 'string', description: 'Document body as Markdown' },
      format: { type: 'string', enum: ['pdf', 'html'], description: 'Defaults to the path extension' },
    },
    required: ['path', 'title', 'markdown'],
  },
  async run(
    input: { path: string; title: string; markdown: string; format?: 'pdf' | 'html' },
    ctx,
  ): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    const format = input.format ?? (extname(abs).toLowerCase() === '.pdf' ? 'pdf' : 'html')
    if (!(await ctx.confirm('Write document', input.path))) return fail('Denied by user.')

    const html = wrapHtmlDocument(input.title, markdownToHtml(input.markdown))
    await mkdir(dirname(abs), { recursive: true })

    if (format === 'html') {
      await writeFile(abs, html, 'utf8')
      return ok(`Wrote ${input.path}`)
    }

    const htmlPath = abs.replace(/\.pdf$/i, '') + '.html'
    await writeFile(htmlPath, html, 'utf8')

    const chrome = await findChrome()
    if (!chrome) {
      return ok(
        `No headless Chrome or Edge found, so the PDF could not be rendered. ` +
          `The HTML was written to ${htmlPath} — open it and print to PDF, or install Edge/Chrome.`,
      )
    }

    const proc = Bun.spawn(
      [
        chrome,
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        `--print-to-pdf=${abs}`,
        '--print-to-pdf-no-header',
        `file:///${htmlPath.replace(/\\/g, '/')}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const code = await proc.exited
    if (code !== 0 || !existsSync(abs)) {
      const err = await new Response(proc.stderr).text()
      return ok(`PDF rendering failed (exit ${code}). HTML is at ${htmlPath}.\n${err.slice(0, 400)}`)
    }
    return ok(`Wrote ${input.path}`)
  },
}

async function findChrome(): Promise<string | undefined> {
  const candidates = [
    process.env.ZEUS_CHROME,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[]
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}

export const appendTool: Tool = {
  name: 'append_file',
  description:
    'Append text to a file, creating it if absent. Use for building a long document incrementally rather than rewriting it.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  async run(input: { path: string; content: string }, ctx): Promise<ToolResult> {
    const abs = contain(input.path, ctx)
    if (!(await ctx.confirm('Append to file', input.path))) return fail('Denied by user.')
    await mkdir(dirname(abs), { recursive: true })
    const prior = existsSync(abs) ? await readFile(abs, 'utf8') : ''
    await writeFile(abs, prior + input.content, 'utf8')
    return ok(`Appended ${input.content.split('\n').length} lines to ${input.path}`)
  },
}

export const artifactTools: Tool[] = [documentTool, appendTool]
