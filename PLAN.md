# Zeus — the plan to 10/10

> For one person building alone, with a swappable set of local brains and no
> per-token bill. Not a product. The bar is nevertheless that it beats what
> billion-dollar companies ship.

---

## The thesis

Zeus will not win on raw model intelligence. A 30B local model loses to a
frontier model on any single-shot task, and prompt tuning does not close that
gap. Competing on "smarter answers" is a losing frame, and it gets worse every
time the registry is replaced.

Zeus wins on three things no session-bound, single-model, cloud-hosted tool can
copy:

1. **It refuses to believe a brain until the work is verified.**
   Everyone else lets the model decide when it is done. That works while the
   model is excellent and fails silently when it is not.
2. **It compounds.** Tools built, lessons learned and decisions made persist
   and are reused. Every other coding agent starts cold every session.
3. **It survives.** Work outlives the context window, the session, and the power
   supply. Proven on 2026-08-12: a job resumed at the correct step after a hard
   outage.

The goal is therefore not a better brain. It is **a harness so good that a
mediocre, swappable brain still produces reliable work.** That target survives
every hardware and model change, which is the only kind of target worth building
toward here.

---

## Where we are (measured 2026-08-12)

Ratings are evidence-based. Anything not measured is marked unproven, not
assumed good.

| Area | Now | Basis |
|---|---|---|
| Architecture | 8 | Registry/adapter/router split is genuinely model-agnostic. The tool-call shim makes "any brain" a fact. |
| Job Engine | 8 | Resumed correctly after a hard power cut. Measured, not claimed. |
| Containment | 7 | 7/7 escape vectors refused with approval already granted. Narrow but verified. **Shell escape untested.** |
| Agent loop reliability | 3 | 3/4 at best on elementary tasks; unstable run to run. |
| Test coverage | 3 | Two harnesses. `race`, `pipe`, `serve` never run end to end. |
| **Overall** | **≈5** | High ceiling. Not yet a reliable coder. |

**Is it best in class today? No.** A frontier tool passes all four capability
cases without effort; the best local brain here manages three, sometimes. Being
honest about this is what makes the plan worth following.

Already ahead of the field: resumable work, multi-brain orchestration, tool-less
model support, zero telemetry, egress ledger.

---

## What 10/10 means

A rating is only real if it has an exit criterion that can fail.

| Area | 10/10 is |
|---|---|
| Architecture | Replace every brain in the registry; every feature still works with **zero source edits** and no manual role fixing. |
| Agent loop | Capability suite at **100%, `--repeat=5`, across ≥3 unrelated brains** — including a weak one. |
| Job Engine | The 600-page-book benchmark completes end to end, resumable, with continuity holding across chapters. |
| Containment | Adversarial suite passes including **shell and network** escapes, not only file paths. |
| Test coverage | Every command has an end-to-end test; the whole suite runs **without a GPU** via a scripted fake brain. |
| Overall | A day's real work — code, or research, or a design — completed without the operator checking the model's claims by hand. |

---

## Phase 1 — Make it reliable (the weekend)

The two items that fix what was actually measured.

### 1.1 Acceptance gate
Every task carries a machine-checkable definition of done: a command that must
exit zero, a file that must exist and parse, output that must match. `finish` is
**rejected** until the check passes, and the failure output is fed back as the
next turn's input.

Why first: on 2026-08-12 the coder wrote a *correct* program and never ran it,
so the artifact never appeared — while the summary claimed success. An
acceptance gate turns that from a silent failure into an automatic retry. It is
model-independent by construction, so it keeps working after the drive swap.

### 1.2 Capability-driven role assignment
Roles must come from **measured** results, not from guessing at model names.
`scripts/assign-roles.ts` guessed, picked the wrong coder, and nothing
downstream noticed — while two other brains scored higher on the same suite.

Replace the heuristic: run the capability suite, assign `coder`, `reviewer`,
`architect` from what each brain actually did. Swapping the drive then re-derives
roles from evidence instead of silently mis-assigning 25 unknown models.

### 1.3 Retry with the failure as input
When a check fails, feed the real error back rather than restating the task.
Cheapest reliability gain available.

**Exit:** capability suite at 100%, `--repeat=3`, on at least two brains.

---

## Phase 2 — Make it trustworthy

### 2.1 A no-GPU test path
A scripted fake brain that replays fixed responses, so the loop, router,
failover, shim, permissions and job engine can be tested deterministically in
seconds with no model loaded. Without this, every regression costs GPU minutes
and nothing gets tested often enough.

**This is the highest-leverage item in the whole plan after the acceptance
gate** — it is what makes all later work safe to do quickly.

### 2.2 Cover the untested surface
`race`, `pipe`, `serve`, `job`, `checkpoint`, `ledger` end to end. One
containment bug in `race` was already found by reading; more will be found by
running.

### 2.3 Close the containment gap
File tools are contained. The **shell tool is not** — a command can leave the
allowed roots freely, which undermines unattended runs. Contain process
execution, and extend the adversarial suite to cover it.

**Exit:** `bun test` green with no GPU; adversarial suite covers file, shell and
network.

---

## Phase 3 — Make it compound

### 3.1 A toolbox that persists
A tool Zeus builds on Tuesday should exist, registered and tested, on Friday.
Built tools get a name, a test and a manifest entry, and are offered back to
future tasks.

This is the only item that **compounds**, and the strongest long-term edge
available — every rival starts cold each session.

### 3.2 Race to green
Keep the first attempt that *passes* the acceptance check, not the one a judge
preferred. Local inference is free here; N attempts beat one hope. This is
structurally unavailable to metered cloud tools.

### 3.3 Project continuity
Extend checkpointing from job state to project knowledge: decisions, conventions,
approaches already tried and rejected. Re-deriving context every session is a tax
nobody else has removed.

**Exit:** a tool built in one session is used unprompted in a later one.

---

## Phase 4 — Make it universal

### 4.1 Composable workflows
Today `design`/`book`/`research` is a fixed menu, and anything else falls back to
generic. Security research on Tuesday and futuristic hardware design on Wednesday
only works if Zeus can **assemble** a workflow for a domain nobody pre-wrote:
choose the roles, the stages, the tools, and — critically — the acceptance check.

This is the same problem as the Mandate Engine in the Grand Strategy project, and
solving it is what makes Zeus categorically different rather than incrementally
better.

### 4.2 Multi-modal work as a first-class path
Blueprints, diagrams, audio, video. The registry already carries `kind`; the
workflows do not yet use it.

**Exit:** a domain never coded for — pick one at random — is completed end to end
without adding a recipe.

---

## The mixed roster — cloud thinks, local acts

Planned once the new drive is in: the best abliterated local models, plus Ollama
Cloud, plus a frontier API brain such as Grok, with the best brain chosen per
task including swarm jobs.

This spans every phase, so it is recorded here rather than inside one.

### The constraint, and the design that resolves it

Local-and-supervised-only is a locked requirement: no remote brain drives file
tools on this machine. Taken naively that rules out cloud brains entirely, which
would give up real quality for no reason.

It doesn't, because **the roles that benefit most from a stronger brain are the
ones that never touch files**:

| Role | Brain | Why |
|---|---|---|
| **Judge** (swarm, race) | cloud | Reads submitted answers, picks one. Zero file access. The single highest-leverage seat — a frontier judge lifts a whole tournament of modest local models. |
| **Architect / planner** | cloud | Text in, text out. Planning quality propagates into every later stage. |
| **Reviewer / critic** | cloud | Reads the work as text. Adversarial review is where a stronger brain pays off most. |
| **Coder / builder** | **local** | Executes tools, reads and writes files. Stays on this machine. |
| **Anything with tool access** | **local** | Same reason. |

So the split is not a compromise — it is arguably the better architecture. The
seats where a frontier model helps most are exactly the seats that need no
filesystem. `pipeline.ts` already selects stages by role, so this needs no new
mechanism: assign the roles and it happens.

### Consequences to plan for

- **The economics invert.** Racing four local brains costs time only; racing four
  cloud brains bills four times per attempt, and `race`/`swarm` multiply calls by
  design. `--budget` exists. The escalation ladder (D2) becomes the cost control:
  only tasks that fail verification ever reach the expensive brain.
- **The egress ledger becomes load-bearing.** With a mixed roster it is the only
  record of what left the machine and what it cost. Read it weekly, not never.
- **`-cloud` models are not local.** They route through `localhost:11434` and
  execute remotely. The registry must label them `locality: remote` or the ledger
  lies and the privacy rule is broken by accident rather than decision.
- **Grok needs no new code.** The `openai-compat` adapter already covers xAI —
  eight lines in `brains.yaml`, a different endpoint, `auth: env:YOUR_KEY`. Never
  a literal secret in the file.
- **Cloud brains must still be probed and measured.** They are not exempt from
  the capability suite for judging or planning quality — but the suite's file
  cases stay local, so cloud brains are benchmarked on text tasks only.

---

## Benchmarks that define done

1. **Capability suite** — 100%, `--repeat=5`, ≥3 unrelated brains including a weak one.
2. **Cold-swap test** — replace the entire registry; everything works, no source edits.
3. **600-page book** — completes, resumable, continuity holds.
4. **Unattended day** — a full day's real work with no hand-checking of claims.
5. **Adversarial containment** — file, shell and network escapes all refused.

---

## Deliberately not doing

- Chasing frontier models on raw reasoning. Not winnable, not necessary.
- Prompt tuning for specific models. They are being replaced.
- UI polish before the verification layer exists. A prettier wrapper around
  unverified output is worse than none — it makes false confidence more
  convincing.
- Selling it. Settled; not for sale.

---

## The one-line version

Not a smarter brain — **a harness that makes a swappable, mediocre brain
reliable, and that gets better every week while everything else starts over.**

---
---

# The R&D programme

## What R and D mean here

**Research** is finding out what is true. Probing, measuring, comparing,
deliberately trying to break things. Its output is **evidence**, not code.

**Development** is building on that evidence. Its output is working code.

The discipline: **R before D, and D only where R has pointed.** Every one of the
seven bugs fixed on 2026-08-12 was found by measuring, not by reading code — and
the morning's plan would have built the wrong things, because it was written
before the evidence existed.

Three standing rules, each learned the hard way:

1. **Never trust a declared capability.** Probe it. Models reject tool calls they
   advertise; package managers are absent; the registry lies after a drive swap.
2. **A broken oracle is worse than none.** The test harness once failed a
   *correct* answer because its own ground-truth command was malformed. Every
   oracle must be able to report its own failure as a distinct result.
3. **A green suite you wrote yourself proves nothing.** Ground truth must come
   from outside the thing being tested — execute the program, read the disk, ask
   the OS.

---

## The improvement ratchet

The system must get better on its own schedule, not only when someone
remembers. Four mechanisms, in order of leverage:

### R1 — Every failure becomes a permanent test
Any real failure — a stall, a wrong answer, a containment slip — is captured as
a fixture and added to the suite. The same bug is never fixed twice, and the
suite grows from reality rather than imagination.

### R2 — The score may never go down
The capability and containment suites record a high-water mark. A change that
lowers it is a regression by definition and blocks the work, regardless of what
it was meant to improve. This is what makes "keep it improving" a mechanism
instead of an intention.

### R3 — Re-benchmark on every registry change
Swapping models silently invalidates every role assignment and every measured
capability. Detect that the registry changed, re-run the suite, re-derive roles
from evidence. The drive swap becomes a routine event instead of a cliff.

### R4 — Zeus improves Zeus
Once Phase 2 lands, features are built **through Zeus**, using `race --verify`
against its own test suite. The tool's real benchmark is whether it can improve
itself under its own acceptance gates. Nothing else measures the whole system at
once, and no rival can run this experiment on a personal machine.

---

## Standing research questions

Open questions worth real experiments, with what would settle each.

| # | Question | Experiment that settles it |
|---|---|---|
| Q1 | Does verification beat model size? | Small brain + acceptance gate + retry, versus large brain unaided, on the same suite. |
| Q2 | How much does N-attempt racing buy? | Pass rate at N = 1, 3, 5 on one brain. Find where it flattens. |
| Q3 | Who should write the acceptance check? | Same brain versus a different brain. Measure how often a self-written check is trivially passed. |
| Q4 | Is the shim as good as native tool calling? | Same tasks, shim forced on versus native, on a brain that supports both. |
| Q5 | Where is the real ceiling — model or harness? | Run the suite with a frontier brain in a throwaway sandbox. If it also fails, the harness is the ceiling. |
| Q6 | Does decomposition help or hurt small brains? | Same task as one prompt versus a pipeline of small steps. |
| Q7 | How unstable are these brains, really? | `--repeat=10` on one brain. Variance is a first-class number, not noise. |

Q5 and Q7 are the two most worth running early: one tells you whether to keep
investing in the harness, the other tells you whether any single-run measurement
can be trusted at all.

---

## Out-of-the-box directions

Ideas that are not obvious extensions of what exists. Ranked by expected value,
not by ease.

### D1 — Cross-brain acceptance checks
The brain doing the work must not write its own test. A second brain writes the
check from the task description *before* the work starts. This kills the
dominant failure mode of self-grading — a model that writes a test it happens to
pass — and it costs one cheap call. **Highest value per unit of effort on this
list.**

### D2 — The escalation ladder
Start every task on the cheapest, fastest brain. Escalate to a larger one only
when the acceptance check fails. This is backwards from how every commercial
tool works — they run one large model at everything, because they are billing
for it. On a personal machine the economics invert: most tasks are trivial, and
the small brain plus verification handles them. Expect large speed gains at
equal reliability.

With a mixed roster this becomes the primary **cost** control as well as a speed
one: small local → large local → cloud, with each rung entered only on a failed
acceptance check. Most work never leaves the machine, and the metered brain is
reached only by tasks that have already proved they are hard. Note this only
works once the acceptance gate exists — without a real pass/fail signal there is
nothing to escalate *on*, and the ladder degrades into guessing.

### D3 — Deterministic replay from a failure corpus
Every recorded failure becomes a scripted fake-brain fixture. The whole loop is
then testable in seconds with no GPU, and every past failure is re-checked on
every change. This is what makes R1 and R2 practical rather than aspirational.

### D4 — Speculative decomposition
Generate several different decompositions of a hard task in parallel; keep the
one whose early sub-steps actually verify. Cheap locally, impossible on a metered
API, and it attacks the failure that hurts most — a long job that was doomed by
its plan at step 2.

### D5 — Prompt compilation per brain
Measure which prompt shapes each brain responds to, store the finding in the
registry, apply automatically. Turns "the new models behave differently" from a
crisis into a measurement. Directly serves the swappable-brain requirement.

### D6 — Retrieval-backed continuity
An embedding brain is already registered and working. Use it for project memory:
decisions, conventions, dead ends. The point is not summarising — it is never
re-litigating a settled question or re-trying a known dead end.

### D7 — An adversary in the loop
A standing role whose only job is to break the current build: fuzz the tools,
attack containment, look for claims unsupported by artifacts. Adversarial review
already outperforms self-review at the task level; the same should be true of
the system.

### D8 — Verified autonomy
Checkpoints plus acceptance gates make unattended work *safe* rather than
merely fast, because every change is both verified and revertible. That is the
honest route to the "wake up to finished work" ambition — and it is only
available once Phase 1 and 2 exist. Attempting it earlier produces confident
wreckage.

---

## Cadence

- **Per change:** typecheck, containment suite, no-GPU suite. Minutes.
- **Per session:** capability suite on the working brain. Record the number.
- **Per registry change:** full re-benchmark, roles re-derived (R3).
- **Weekly:** review the failure corpus; promote recurring failures to plan items;
  re-rate the table at the top of this document against evidence.

Ratings in this document are only ever updated from measurements. A rating
raised without an experiment behind it is a lie to a future reader — most likely
oneself, months later, with no memory of how the number was reached.
