import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerRecipe, type Recipe, type StepContext } from '../engine.ts'
import type { AcceptanceCheck } from '../acceptance.ts'
import { markdownToHtml, wrapHtmlDocument } from '../../agent/tools/artifacts.ts'

/**
 * The design recipe — Zeus's R&D loop.
 *
 * Engineering work is not one long answer. It is a brief, a decomposition into
 * subsystems, a specification per subsystem, an integration pass, a costed bill
 * of materials, an adversarial review by a *different* brain, a revision, and a
 * rendered deliverable.
 *
 * The critique step is the point of the whole thing. A brain reviewing its own
 * work grades generously; a second brain given the explicit job of finding what
 * is wrong finds considerably more. That gap is where the quality comes from,
 * and it is available to Zeus precisely because it is not tied to one brain.
 */

const ENGINEER = `You are a senior design engineer. You are rigorous and concrete.
State numbers with units. Show the arithmetic behind any figure you claim.
Where a value depends on a part you have not chosen, name the part you assume and why.
Flag anything you are uncertain about explicitly rather than writing around it —
an unflagged guess in an engineering document is a defect.`

const CRITIC = `You are an adversarial design reviewer. Your job is to find what is wrong.
You are reviewing someone else's work and you are not being graded on politeness.

Look specifically for:
- Numbers that do not add up, or units that do not reconcile
- Missing components that the design implicitly requires
- Thermal, power, timing, tolerance or mechanical constraints that were not checked
- Safety and failure modes that were not considered
- Costs that are missing, stale, or optimistic
- Assumptions stated as facts

Report findings as a numbered list, most severe first. For each: what is wrong,
why it matters, and what specifically to change. If a section is genuinely sound,
say so in one line and move on — do not manufacture findings to seem thorough.`

function heading(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`
}

async function brief(ctx: StepContext) {
  const { text } = await ctx.think({
    system: ENGINEER,
    role: 'architect',
    prompt: `A design task has been given:

${ctx.job.goal}

Write the design brief. Cover, under clear headings:

1. **Requirements** — what it must do, as testable statements.
2. **Constraints** — size, power, budget, environment, regulatory, materials.
3. **Success criteria** — how we will know the finished thing works.
4. **Open questions** — what the requester has not specified that materially
   changes the design. State the assumption you will proceed on for each.
5. **Subsystems** — break the design into 3 to 8 subsystems. For each, one line
   on what it is responsible for.

End with a line reading exactly:
SUBSYSTEMS: name one; name two; name three`,
  })

  const line = /SUBSYSTEMS:\s*(.+)/i.exec(text)
  const names = (line?.[1] ?? '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 8)

  // A brief that yields no subsystems still produces a design; it just designs
  // the whole thing as one unit rather than failing.
  const subsystems = names.length ? names : ['Whole system']

  return {
    output: heading('Design brief', text.replace(/SUBSYSTEMS:.*/i, '').trim()),
    patchState: { subsystems },
    spawn: subsystems.map((name, i) => ({
      kind: 'subsystem',
      title: `Specify: ${name}`,
      input: { name },
      ord: 10 + i,
    })),
  }
}

async function subsystem(ctx: StepContext) {
  const { name } = JSON.parse(ctx.step.input) as { name: string }
  const brief = ctx.priorOutputs('brief').join('\n\n')

  const { text } = await ctx.think({
    system: ENGINEER,
    role: 'architect',
    prompt: `${brief}

---

Specify the **${name}** subsystem in full detail.

Cover:
- **Function** — what it does and how it interfaces with the rest.
- **Approach** — the design, with the reasoning for it. If there was a real
  alternative, say what it was and why you rejected it.
- **Components** — every part needed, with a specific part number or an exact
  description where a part number is not warranted. Include passives and connectors.
- **Calculations** — the sizing arithmetic, shown. Power, current, thermal,
  timing, mechanical loads, tolerances, whatever governs this subsystem.
- **Interfaces** — signals, voltages, protocols, connectors, mounting.
- **Risks** — what is most likely to be wrong here.

Be specific enough that someone could source the parts and build it.`,
  })

  return { output: heading(`Subsystem — ${name}`, text) }
}

async function integrate(ctx: StepContext) {
  const specs = ctx.priorOutputs('subsystem').join('\n\n---\n\n')
  const brief = ctx.priorOutputs('brief').join('\n\n')

  const { text } = await ctx.think({
    system: ENGINEER,
    role: 'architect',
    maxTokens: 12000,
    prompt: `${brief}

---

The subsystems have been specified independently:

${specs}

---

Now integrate them. Produce:

- **System architecture** — how the subsystems connect. Describe the block
  diagram in words precisely enough to draw it, then give it as a Mermaid
  \`graph TD\` block.
- **Interface reconciliation** — go through each interface between subsystems
  and confirm both sides agree on voltage, signal, connector and protocol.
  Where they do not, say so plainly and resolve it.
- **Power budget** — a table of every consumer, its draw, and the total, with
  headroom stated.
- **Physical layout** — how it is arranged and mounted.
- **Assembly order** — the sequence a person would actually build it in.

If integrating them exposed a conflict that requires changing a subsystem, say
which subsystem and what must change.`,
  })

  return { output: heading('Integration', text) }
}

async function bom(ctx: StepContext) {
  const specs = ctx.priorOutputs('subsystem').join('\n\n')

  const { text } = await ctx.think({
    system: ENGINEER,
    role: 'architect',
    prompt: `From these subsystem specifications, produce the bill of materials.

${specs}

---

Give a single Markdown table with these columns:

| # | Part | Spec / Part number | Qty | Unit cost (USD) | Line cost | Source | Notes |

Rules:
- Every component from every subsystem, including passives, connectors and fasteners.
- Where you do not know a current price, write your estimate and mark the Notes
  column "estimate". Do not silently invent a precise figure.
- Sum the line costs and state the total.
- Then add: estimated tooling/equipment needed but not consumed, and an
  estimated build time in hours.

After the table, list the three line items most likely to be wrong or volatile in price.`,
  })

  return { output: heading('Bill of materials', text) }
}

async function critique(ctx: StepContext) {
  const everything = [
    ...ctx.priorOutputs('brief'),
    ...ctx.priorOutputs('subsystem'),
    ...ctx.priorOutputs('integrate'),
    ...ctx.priorOutputs('bom'),
  ].join('\n\n---\n\n')

  // Deliberately routed to the reviewer role so a different brain sees it.
  const { text, brainId } = await ctx.think({
    system: CRITIC,
    role: 'reviewer',
    maxTokens: 8000,
    prompt: `Review this design against its own stated requirements.

${everything}

---

Find what is wrong with it.`,
  })

  return {
    output: heading(`Review${brainId ? ` (by ${brainId})` : ''}`, text),
    patchState: { lastCritique: text },
  }
}

async function revise(ctx: StepContext) {
  const critiques = ctx.priorOutputs('critique').join('\n\n')
  const design = [
    ...ctx.priorOutputs('brief'),
    ...ctx.priorOutputs('subsystem'),
    ...ctx.priorOutputs('integrate'),
    ...ctx.priorOutputs('bom'),
  ].join('\n\n---\n\n')

  const { text } = await ctx.think({
    system: ENGINEER,
    role: 'architect',
    maxTokens: 12000,
    prompt: `Here is a design, and a reviewer's findings against it.

# The design
${design}

# The review
${critiques}

---

Work through the findings one at a time. For each:
- If it is correct, state the change and make it.
- If it is wrong, say why, with the evidence. A reviewer can be mistaken and you
  should not change a correct design to satisfy an incorrect finding.

Then produce the **revised design summary**: what changed, what the design now
is, and what remains genuinely uncertain.`,
  })

  return { output: heading('Revision', text) }
}

async function instructions(ctx: StepContext) {
  const design = [...ctx.priorOutputs('integrate'), ...ctx.priorOutputs('revise')].join('\n\n')
  const parts = ctx.priorOutputs('bom').join('\n\n')

  const { text } = await ctx.think({
    system: ENGINEER,
    role: 'architect',
    maxTokens: 12000,
    prompt: `Write the build instructions for this design.

${design}

${parts}

---

Write them for a competent person who has never seen this design. Number every
step. State the tool needed for each step. Call out torque values, polarity,
orientation, and anything that is destructive if done wrong.

Include, in order:
1. Safety warnings specific to this build.
2. Tools and consumables required.
3. Preparation and part verification.
4. Numbered assembly steps, grouped by subsystem.
5. Test and commissioning procedure — how to verify each subsystem works
   *before* powering the whole thing, with expected readings.
6. Troubleshooting: the five most likely symptoms and what causes each.`,
  })

  return { output: heading('Build instructions', text) }
}

async function render(ctx: StepContext) {
  const order = ['brief', 'subsystem', 'integrate', 'bom', 'critique', 'revise', 'instructions']
  const body = order.flatMap(k => ctx.priorOutputs(k)).join('\n\n')
  const md = `# ${ctx.job.title}\n\n*${ctx.job.goal}*\n\n${body}`

  const mdPath = join(ctx.workdir, 'design.md')
  const htmlPath = join(ctx.workdir, 'design.html')
  writeFileSync(mdPath, md, 'utf8')
  writeFileSync(htmlPath, wrapHtmlDocument(ctx.job.title, markdownToHtml(md)), 'utf8')

  return {
    output:
      `Wrote:\n  ${mdPath}\n  ${htmlPath}\n\n` +
      `Render to PDF with:  zeus pdf "${htmlPath}"`,
    // Acceptance gate: the step is not "done" on the handler's word that it
    // wrote the deliverables — the engine confirms both files actually exist on
    // disk before marking it done. Returned by the handler (not seeded), so it
    // also covers the render step queued by an improvement pass.
    accept: [
      { kind: 'file_exists', path: 'design.md' },
      { kind: 'file_exists', path: 'design.html' },
    ] satisfies AcceptanceCheck[],
  }
}

export const designRecipe: Recipe = {
  kind: 'design',
  description:
    'Engineering R&D: brief, subsystem specs, integration, costed BOM, adversarial review by a second brain, revision, build instructions, rendered document.',
  seed: () => [
    { kind: 'brief', title: 'Design brief and decomposition', ord: 0 },
    { kind: 'integrate', title: 'System integration', ord: 100 },
    { kind: 'bom', title: 'Bill of materials and costing', ord: 110 },
    { kind: 'critique', title: 'Adversarial review', ord: 120 },
    { kind: 'revise', title: 'Revision against review', ord: 130 },
    { kind: 'instructions', title: 'Build instructions', ord: 140 },
    { kind: 'render', title: 'Render deliverable', ord: 150 },
  ],
  handlers: { brief, subsystem, integrate, bom, critique, revise, instructions, render },
}

registerRecipe(designRecipe)

/**
 * Append another critique/revise cycle to a finished design.
 * This is the "ever expanding improvements" path: each pass is adversarial
 * review by a second brain followed by a revision, and passes can be stacked.
 */
export function queueImprovementPass(jobId: string, store: typeof import('../store.ts')): number {
  const existing = store.steps(jobId)
  const base = Math.max(0, ...existing.map(s => s.ord)) + 1
  store.addStep({ jobId, kind: 'critique', title: `Review pass ${countPasses(existing) + 1}`, ord: base })
  store.addStep({ jobId, kind: 'revise', title: `Revision pass ${countPasses(existing) + 1}`, ord: base + 1 })
  store.addStep({ jobId, kind: 'render', title: 'Re-render deliverable', ord: base + 2 })
  return 3
}

function countPasses(steps: Array<{ kind: string }>): number {
  return steps.filter(s => s.kind === 'critique').length
}
