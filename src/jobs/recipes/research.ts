import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerRecipe, type Recipe, type StepContext } from '../engine.ts'
import { markdownToHtml, wrapHtmlDocument } from '../../agent/tools/artifacts.ts'

/**
 * The research recipe.
 *
 * A question is decomposed into independent lines of enquiry, each investigated
 * separately, then synthesised. The final pass is a separate brain checking the
 * synthesis against its own sources — because a confident synthesis of thin
 * evidence is the characteristic failure of this kind of work.
 */

const RESEARCHER = `You are a careful researcher. Distinguish clearly between what you
know, what you infer, and what you are guessing. Where you are relying on
training data that may be stale, say so. Never invent a citation, a figure, or a
source — if you do not have one, say you do not have one.`

const CHECKER = `You are fact-checking a research document. For each substantive claim,
judge whether it is well-supported, plausible but unverified, or doubtful.
Flag any figure, date, name or citation that looks invented. Be specific about
which claim you are challenging.`

async function question(ctx: StepContext) {
  const { text } = await ctx.think({
    system: RESEARCHER,
    role: 'architect',
    prompt: `Research question:

${ctx.job.goal}

Before investigating, scope it. Produce:

1. **What is actually being asked** — restate it precisely.
2. **What would count as an answer** — what form does a good answer take.
3. **Sub-questions** — 3 to 6 independent lines of enquiry that together answer it.
4. **What could make this hard** — where the evidence is likely thin or contested.

End with a line reading exactly:
LINES: first line; second line; third line`,
  })

  const m = /LINES:\s*(.+)/i.exec(text)
  const lines = (m?.[1] ?? '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 6)

  const enquiries = lines.length ? lines : ['The question as stated']

  return {
    output: `## Scope\n\n${text.replace(/LINES:.*/i, '').trim()}\n`,
    patchState: { enquiries },
    spawn: enquiries.map((name, i) => ({
      kind: 'investigate',
      title: `Investigate: ${name.slice(0, 60)}`,
      input: { name },
      ord: 10 + i,
    })),
  }
}

async function investigate(ctx: StepContext) {
  const { name } = JSON.parse(ctx.step.input) as { name: string }
  const scope = ctx.priorOutputs('question').join('\n')

  const { text } = await ctx.think({
    system: RESEARCHER,
    role: 'reasoner',
    maxTokens: 8000,
    prompt: `${scope}

---

Investigate this line of enquiry in depth:

**${name}**

Give what you actually know, with the reasoning. Where there is disagreement in
the field, present both positions. Mark each substantive claim as
[established], [likely], or [uncertain]. Finish with what you would need to
look up to be confident.`,
  })

  return { output: `## ${name}\n\n${text}\n` }
}

async function synthesize(ctx: StepContext) {
  const findings = ctx.priorOutputs('investigate').join('\n\n---\n\n')
  const scope = ctx.priorOutputs('question').join('\n')

  const { text } = await ctx.think({
    system: RESEARCHER,
    role: 'architect',
    maxTokens: 12000,
    prompt: `${scope}

# Findings from each line of enquiry
${findings}

---

Synthesise these into an answer to the original question.

Structure it as: the answer up front in one paragraph, then the reasoning, then
the caveats. Where the lines of enquiry contradicted each other, resolve it
explicitly or say that it is unresolved. Do not smooth over disagreement.

End with **What would change this conclusion** — the specific finding that would
overturn it.`,
  })

  return { output: `## Synthesis\n\n${text}\n` }
}

async function check(ctx: StepContext) {
  const synthesis = ctx.priorOutputs('synthesize').join('\n')

  const { text, brainId } = await ctx.think({
    system: CHECKER,
    role: 'reviewer',
    maxTokens: 6000,
    prompt: `Check this research synthesis.

${synthesis}

---

Go through it claim by claim. Flag anything that looks invented, overstated, or
unsupported by the reasoning given.`,
  })

  return { output: `## Verification${brainId ? ` (by ${brainId})` : ''}\n\n${text}\n` }
}

async function render(ctx: StepContext) {
  const body = ['question', 'investigate', 'synthesize', 'check'].flatMap(k => ctx.priorOutputs(k)).join('\n\n')
  const md = `# ${ctx.job.title}\n\n*${ctx.job.goal}*\n\n${body}`
  const mdPath = join(ctx.workdir, 'research.md')
  const htmlPath = join(ctx.workdir, 'research.html')
  writeFileSync(mdPath, md, 'utf8')
  writeFileSync(htmlPath, wrapHtmlDocument(ctx.job.title, markdownToHtml(md)), 'utf8')
  return { output: `Wrote:\n  ${mdPath}\n  ${htmlPath}` }
}

export const researchRecipe: Recipe = {
  kind: 'research',
  description:
    'Investigate a question: scope, parallel lines of enquiry, synthesis, and a fact-check by a second brain.',
  seed: () => [
    { kind: 'question', title: 'Scope the question', ord: 0 },
    { kind: 'synthesize', title: 'Synthesise findings', ord: 100 },
    { kind: 'check', title: 'Fact-check', ord: 110 },
    { kind: 'render', title: 'Render document', ord: 120 },
  ],
  handlers: { question, investigate, synthesize, check, render },
}

registerRecipe(researchRecipe)
