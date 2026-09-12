import { writeFileSync, appendFileSync, existsSync, writeFileSync as write } from 'node:fs'
import { join } from 'node:path'
import { registerRecipe, type Recipe, type StepContext } from '../engine.ts'
import { markdownToHtml, wrapHtmlDocument } from '../../agent/tools/artifacts.ts'

/**
 * The long-form writing recipe.
 *
 * A 600-page book is roughly 200,000 words. No context window holds it, and no
 * single generation produces it. What makes it tractable is that a chapter only
 * needs three things: the outline, a bible of established facts, and a summary
 * of what immediately precedes it.
 *
 * So each chapter is drafted in its own step against that compact context, its
 * summary is folded back into the running state, and the manuscript is appended
 * to disk as it goes. The job can be stopped after chapter 12 and resumed a week
 * later at chapter 13 with no loss.
 */

const AUTHOR = `You are a working novelist. You write clean, specific prose.
Concrete detail over abstraction. Dialogue that sounds like people talking.
You never summarise a scene you should be writing, and you never pad to reach a
length — if a scene is finished, it is finished.`

const EDITOR = `You are a developmental editor. You are reviewing a manuscript for
continuity and craft. Report problems concretely, citing the chapter. Do not
praise. If something is inconsistent with established facts, say exactly which
fact and where it was established.`

type BookState = {
  outline?: string
  bible?: string
  chapters?: Array<{ n: number; title: string; synopsis: string }>
  summaries?: Record<number, string>
  wordTarget?: number
}

function manuscriptPath(ctx: StepContext): string {
  return join(ctx.workdir, 'manuscript.md')
}

async function outline(ctx: StepContext) {
  const st = ctx.state as BookState
  const target = st.wordTarget ?? 200_000
  const chapters = Math.max(12, Math.round(target / 3500))

  const { text } = await ctx.think({
    system: AUTHOR,
    role: 'architect',
    maxTokens: 12000,
    prompt: `Plan a book from this premise:

${ctx.job.goal}

Target length: about ${target.toLocaleString()} words across roughly ${chapters} chapters.

Produce:

1. **Premise** — one paragraph on what this book actually is.
2. **Shape** — the arc in five or six beats. Where it turns, where it lands.
3. **Chapter list** — exactly ${chapters} entries, each on its own line, in this format:
   CH <number> | <title> | <two-sentence synopsis of what happens>

The chapter lines must be machine-readable, so keep the pipes and use no other
pipe characters in them.`,
  })

  const chapterList: Array<{ n: number; title: string; synopsis: string }> = []
  for (const line of text.split('\n')) {
    const m = /^\s*CH\s*(\d+)\s*\|\s*([^|]+)\|\s*(.+)$/i.exec(line)
    if (m) {
      chapterList.push({ n: Number(m[1]), title: m[2]!.trim(), synopsis: m[3]!.trim() })
    }
  }
  if (!chapterList.length) {
    throw new Error('The outline produced no parseable chapter lines. Retry, or use a stronger brain for the architect role.')
  }

  return {
    output: text,
    patchState: { outline: text, chapters: chapterList },
    spawn: [
      { kind: 'bible', title: 'Story bible', ord: 5 },
      ...chapterList.map(c => ({
        kind: 'chapter',
        title: `Ch ${c.n}: ${c.title}`,
        input: c,
        ord: 10 + c.n,
      })),
      { kind: 'continuity', title: 'Continuity pass', ord: 9000 },
      { kind: 'assemble', title: 'Assemble manuscript', ord: 9010 },
    ],
  }
}

async function bible(ctx: StepContext) {
  const st = ctx.state as BookState

  const { text } = await ctx.think({
    system: AUTHOR,
    role: 'architect',
    maxTokens: 8000,
    prompt: `From this outline, write the story bible.

${st.outline ?? ''}

The bible is the reference every chapter is written against, so it must be
compact and factual — not prose. Include:

- **Characters**: name, age, role, how they speak, what they want, what they fear.
- **Places**: name and the three details that make each recognisable.
- **Rules**: how this world works, including anything that would be a
  continuity error if contradicted.
- **Timeline**: the sequence of events the plot depends on.
- **Names in use**: a flat list of every proper noun, so none drift.

Keep it under 1200 words. It will be sent with every chapter.`,
  })

  return { output: text, patchState: { bible: text } }
}

async function chapter(ctx: StepContext) {
  const st = ctx.state as BookState
  const ch = JSON.parse(ctx.step.input) as { n: number; title: string; synopsis: string }
  const summaries = st.summaries ?? {}

  // Only the immediately preceding chapters matter for continuity of voice and
  // action; the bible carries everything durable.
  const recent = [ch.n - 3, ch.n - 2, ch.n - 1]
    .filter(n => n >= 1 && summaries[n])
    .map(n => `Chapter ${n}: ${summaries[n]}`)
    .join('\n')

  const all = st.chapters ?? []
  const next = all.find(c => c.n === ch.n + 1)

  const { text } = await ctx.think({
    system: AUTHOR,
    role: 'writer',
    maxTokens: 16000,
    prompt: `# Story bible
${st.bible ?? ''}

# What has happened immediately before
${recent || '(this is the opening chapter)'}

${next ? `# What comes next\nChapter ${next.n} — ${next.synopsis}\nEnd this chapter so that follows naturally.\n` : ''}

# Write chapter ${ch.n}: ${ch.title}

${ch.synopsis}

Write the chapter in full — roughly 3,000 to 4,000 words of finished prose.
Open in scene. Do not recap earlier chapters. Do not write a chapter heading;
that is added automatically. Do not write anything after the chapter ends.

After the prose, on its own final line, write:
SUMMARY: <two sentences on what changed in this chapter, for continuity>`,
  })

  const m = /^SUMMARY:\s*(.+)$/im.exec(text)
  const summary = m?.[1]?.trim() ?? ch.synopsis
  const prose = text.replace(/^SUMMARY:.*$/im, '').trim()

  // Append as we go so a crash never costs more than the chapter in flight.
  const path = manuscriptPath(ctx)
  if (!existsSync(path)) write(path, `# ${ctx.job.title}\n\n`, 'utf8')
  appendFileSync(path, `\n\n## Chapter ${ch.n}: ${ch.title}\n\n${prose}\n`, 'utf8')

  const words = prose.split(/\s+/).filter(Boolean).length
  return {
    output: `${words} words — ${summary}`,
    patchState: { summaries: { ...summaries, [ch.n]: summary } },
  }
}

async function continuity(ctx: StepContext) {
  const st = ctx.state as BookState
  const summaries = Object.entries(st.summaries ?? {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([n, s]) => `Chapter ${n}: ${s}`)
    .join('\n')

  const { text } = await ctx.think({
    system: EDITOR,
    role: 'reviewer',
    maxTokens: 8000,
    prompt: `Here is a book's bible and a chapter-by-chapter account of what happened.

# Bible
${st.bible ?? ''}

# Chapter summaries
${summaries}

---

Find continuity errors: contradicted facts, characters who know things they were
never told, timeline impossibilities, names that drifted, threads opened and
never closed. List them by chapter with the specific contradiction. If the book
is consistent, say so plainly rather than inventing findings.`,
  })

  return { output: text }
}

async function assemble(ctx: StepContext) {
  const path = manuscriptPath(ctx)
  if (!existsSync(path)) throw new Error('No manuscript was produced.')

  const md = await Bun.file(path).text()
  const words = md.split(/\s+/).filter(Boolean).length
  const htmlPath = join(ctx.workdir, 'manuscript.html')
  writeFileSync(htmlPath, wrapHtmlDocument(ctx.job.title, markdownToHtml(md)), 'utf8')

  const notes = ctx.priorOutputs('continuity').join('\n\n')
  if (notes) writeFileSync(join(ctx.workdir, 'continuity-notes.md'), notes, 'utf8')

  return {
    output:
      `${words.toLocaleString()} words (~${Math.round(words / 330)} pages)\n` +
      `  ${path}\n  ${htmlPath}\n\nRender to PDF with:  zeus pdf "${htmlPath}"`,
  }
}

export const bookRecipe: Recipe = {
  kind: 'book',
  description:
    'Long-form writing: outline, story bible, chapter-by-chapter drafting against compact context, continuity pass, assembled manuscript. Resumable at any chapter.',
  seed: () => [{ kind: 'outline', title: 'Outline and chapter plan', ord: 0 }],
  handlers: { outline, bible, chapter, continuity, assemble },
}

registerRecipe(bookRecipe)
