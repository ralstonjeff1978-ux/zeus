# Zeus — Completion Plan (to best-in-class)

> Written 2026-09-02. The single sequenced roadmap from today (≈5/10, measured)
> to best-in-class. Companion to [PLAN.md](PLAN.md) (strategy + R&D) and
> [STATUS.md](STATUS.md) (working state). This file is the **execution order**;
> PLAN.md is the *why*, STATUS.md is the *where we are*.

---

## 0. What "best in class" means here (the only definition that can fail)

Not a feeling, not a rating raised by hand. Zeus is done when **all five
benchmarks pass** — these are the acceptance gate for the whole project:

| # | Benchmark | Passes when |
|---|---|---|
| B1 | **Capability** | suite at 100%, `--repeat=5`, ≥3 unrelated brains incl. a weak one |
| B2 | **Cold-swap** | replace the entire registry; every feature works, zero source edits, roles re-derived from measurement |
| B3 | **600-page book** | completes end to end, resumable, continuity holds across chapters |
| B4 | **Unattended day** | a full day's real work completes with no hand-checking of the model's claims |
| B5 | **Adversarial containment** | file, shell **and** network escapes all refused |

The thesis this rests on (from PLAN.md): Zeus does not win on model IQ. It wins
on three structural edges no session-bound, single-model, cloud tool can copy —
it **verifies** before believing a brain, it **compounds** across sessions, and
it **survives** context/session/power loss. Every milestone below invests in one
of those three, never in prompt-tuning a model that is about to be replaced.

---

## 1. The shape of the plan

**One keystone.** Almost everything depends on the **acceptance gate (M1)** —
the escalation ladder, race-to-green, "Zeus improves Zeus," verified autonomy all
need a real pass/fail signal to act on. Build it first or the rest is guessing.

**Two horizons, run in parallel:**
- **Track A (software, buildable now)** — M0 → M9. The whole reliability →
  trust → compound → universal arc. Does **not** wait on hardware.
- **Track B (mixed roster, hardware-gated)** — MR1 → MR3. Starts only when the
  new 2TB drive lands. Nothing in Track A blocks on it, so the drive is never on
  the critical path.

**Two finish lines:**
- **Finish line ①  "I use it every day"** = end of **M4**. Reliable, trustworthy,
  contained. If you stop here, Zeus is legitimately *done* for personal use.
- **Finish line ②  "best in class"** = all five benchmarks (B1–B5) green, which
  lands across M8–M9 + Track B.

**Critical path:** `M1 → M2 → (everything else)`. M1 makes work verifiable; M2
makes verification fast (no-GPU). After M2, every later milestone is cheap to
build and test. Before M2, everything costs GPU minutes and rots.

---

## TRACK A — software

### M0 · Clear the desk  *(hours)*
Loose ends already open, so they stop rotting.
- Resume or kill paused job `design-msqahjs6-onz5` ("USB Desk Lamp", 9/13).
- Settle the coder role: `test:capability <top-two> --repeat=3`, then edit
  `brains.yaml` only if the evidence holds (currently n=1).
- Start `zeus serve` once, by hand, end to end — it has literally never run.
  Just prove it boots; full coverage comes in M3.
- **Exit:** no orphaned job; `brains.yaml` roles backed by ≥3-run evidence;
  `serve` observed to start.

> **Progress 2026-09-02:** orphan job cleared (USB Desk Lamp 9/13 → **13/13**,
> real deliverables written). Env + typecheck verified; Ollama was down, started.
> Role experiment expanded into a **roster refresh** (folds into M0 + previews
> M1.4): two newer abliterated brains pre-registered in `brains.yaml` as PENDING
> PULL — `huihui_ai/Qwen3.8-abliterated:27b` (tool-call-reliability jump, fits
> VRAM) and `huihui_ai/qwen3-coder-next-abliterated` (newest dedicated coder).
> Tomorrow: pull → probe → capability `--repeat=3` → assign coder seat by
> measurement, then stop for review. `serve` boot check still open. Full state in
> [STATUS.md](STATUS.md) "RESUME HERE — 2026-09-02 EOD".

### M1 · Reliability core — **THE KEYSTONE**  *(a weekend+)*
Fixes the one measured failure: agent writes correct code, never runs it, claims
success; unstable run to run.
- **1.1 Acceptance gate.** Every task carries a machine-checkable definition of
  done (a command that must exit zero, a file that must exist and parse, output
  that must match). `finish` is **rejected** until the check passes; the failure
  output is fed back as the next turn's input.
- **1.2 Cross-brain acceptance checks (D1).** A *second* brain writes the check
  from the task description **before** work starts — the worker never grades its
  own homework. Highest value per unit effort on the whole plan; belongs here.
- **1.3 Retry with the failure as input.** Feed the real error back, don't
  restate the task. Cheapest reliability gain available.
- **1.4 Capability-driven roles.** Derive `coder`/`reviewer`/`architect` from
  measured suite results, not guessed model names. (Replaces the heuristic that
  mis-picked the coder.)
- **Exit gate:** capability suite **100%, `--repeat=3`, ≥2 brains.**

### M2 · Testability — **the multiplier**  *(days)*
Everything after this is only as fast as the test loop.
- **2.1 No-GPU test path.** A scripted fake brain replaying fixed responses, so
  loop / router / failover / shim / permissions / job-engine test in **seconds
  with no model loaded.** Highest-leverage item after the gate.
- **2.2 Deterministic replay from a failure corpus (D3).** Every recorded
  failure becomes a fake-brain fixture; the whole loop re-checks every past
  failure on every change.
- **Exit gate:** `bun test` green headless (no GPU); at least the M1 failures
  captured as permanent fixtures.

### M3 · Cover the untested surface  *(days)*
- Run to completion **with an e2e test each:** `race`, `pipe`, `serve`,
  non-`design` `job` recipes, `checkpoint`, `ledger`.
- Fold each new failure found into the M2 corpus (R1, below).
- **Exit gate:** every command has an end-to-end test that runs headless.

### M4 · Containment complete  *(days)*  → **Finish line ① reached**
- Contain the **shell tool** (file tools already are; shell can currently leave
  the allowed roots freely — unattended runs are unbounded until this lands).
- Extend the adversarial suite to **shell + network** escapes, not just paths.
- **Exit gate:** adversarial suite passes file + shell + network = **B5 green.**

### M5 · The improvement ratchet  *(days; then standing)*
Turns "keep it improving" from intention into mechanism.
- **R1** Every real failure → a permanent test fixture (wired via M2).
- **R2** The score may never go down — capability + containment suites hold a
  high-water mark; any change that lowers it is a blocked regression.
- **R3** Re-benchmark + re-derive roles automatically whenever the registry
  changes (makes the drive swap a routine event, not a cliff).
- **Exit gate:** a deliberately introduced regression is auto-blocked by R2; a
  simulated registry change auto-re-derives roles via R3.

### M6 · Make it compound  *(1–2 weeks)*
The only part that gives a widening long-term lead; every rival starts cold.
- **3.1 Persistent toolbox.** A tool Zeus builds gets a name, a test, a manifest
  entry, and is offered back to future tasks.
- **3.2 Race to green.** Keep the first attempt that **passes the acceptance
  check**, not the one a judge preferred. Free locally; structurally impossible
  for metered cloud tools.
- **3.3 Project continuity (D6, retrieval-backed).** Checkpoint decisions,
  conventions, and dead ends using the already-registered embedding brain — so a
  settled question is never re-litigated and a known dead end is never retried.
- **Exit gate:** a tool built in one session is used **unprompted** in a later
  one; B3 (600-page book with continuity) passes.

### M7 · Escalation + economics  *(days)*
- **D2 Escalation ladder.** Start every task on the cheapest, fastest brain;
  escalate to a larger one **only when the acceptance check fails.** (Backwards
  from commercial tools, which bill for one big model on everything.) Needs M1 —
  no gate, nothing to escalate on.
- **D4 Speculative decomposition.** Generate several decompositions of a hard
  task in parallel; keep the one whose early sub-steps actually verify. Attacks
  the worst failure: a long job doomed by its plan at step 2.
- **Exit gate:** measured speed gain at equal-or-better reliability vs single-brain.

### M8 · Self-improvement + verified autonomy  *(1–2 weeks)*
- **R4 Zeus improves Zeus.** Build features **through Zeus**, using `race --verify`
  against its own test suite. The real system-level benchmark.
- **D7 Adversary in the loop.** A standing role whose only job is to break the
  build — fuzz tools, attack containment, flag claims unsupported by artifacts.
- **D8 Verified autonomy.** Checkpoints + acceptance gates make unattended work
  *safe* (every change verified and revertible), not just fast. The honest route
  to "wake up to finished work" — and only safe now that M1/M2/M4 exist.
- **Exit gate:** Zeus lands a real change to itself under its own gates; **B4
  (unattended day, no hand-checking)** passes.

### M9 · Make it universal  *(2+ weeks)*
The "categorically different, not incrementally better" tier.
- **4.1 Composable workflows.** Assemble the roles, stages, tools **and the
  acceptance check** for a domain nobody pre-wrote (same core problem as the
  Grand Strategy "Mandate Engine"). Replaces today's fixed `design`/`book`/
  `research` menu.
- **4.2 Multi-modal as a first-class path.** Blueprints, diagrams, audio, video.
  The registry already carries `kind`; the workflows don't use it yet.
- **Exit gate:** a domain never coded for — pick one at random — completes end to
  end with **no new recipe**.

---

## TRACK B — the mixed roster  *(starts when the 2TB drive lands)*

Design principle (locked): **cloud thinks, local acts.** The seats a frontier
brain helps most are exactly the ones that never touch files, so this honors the
local-and-supervised-only rule instead of breaking it.

### MR1 · New registry, measured
- Populate the new roster: best abliterated local models + Ollama Cloud + a
  frontier API brain.
- **Label every `-cloud` model `locality: remote`** — they route through
  `localhost:11434` but execute remotely; mislabel and the ledger lies and the
  privacy rule breaks by accident.
- Probe and measure everything (cloud brains benchmarked on **text-only** cases;
  file cases stay local).

### MR2 · Wire the split
- Cloud **judge / architect / reviewer** seats (text-in/text-out). A frontier
  judge lifts a whole tournament of modest local brains — the highest-leverage
  seat.
- **Coder and anything with tool access stay local**, always.
- Add the frontier brain (Grok needs **no new adapter** — `openai-compat` covers
  xAI; ~8 lines in `brains.yaml`, `auth: env:` never a literal secret).

### MR3 · Cost control + audit
- Escalation ladder extended: **small local → large local → cloud**, each rung
  entered only on a failed acceptance check. Most work never leaves the machine;
  the metered brain is reached only by tasks that already proved they're hard.
- `--budget` enforced on `race`/`swarm` (they multiply calls by design).
- **Egress ledger becomes load-bearing** — the only record of what left the
  machine and what it cost. Read weekly.
- **Exit gate:** **B2 (cold-swap)** passes — the entire registry replaced, every
  feature works with zero source edits, roles re-derived from evidence.

---

## Research that gates the build (R before D)

Run these experiments; let the evidence redirect the plan (all seven bugs on
2026-08-12 were found by measuring, not reading code).

- **Run early — they decide whether the plan is even right:**
  - **Q5 — model or harness ceiling?** Run the suite with a frontier brain in a
    throwaway sandbox. If it *also* fails, the harness is the ceiling → keep
    investing here. If it passes, the ceiling is model size.
  - **Q7 — how unstable are these brains?** `--repeat=10` on one brain. Tells you
    whether any single-run number can be trusted at all.
- **During M1–M2:** Q1 (does verification beat size?), Q2 (what does N-racing
  buy — where does pass-rate flatten?), Q3 (who writes the check — self vs other).
- **As relevant:** Q4 (shim vs native tool calls), Q6 (decomposition help/hurt
  small brains), D5 (prompt compilation per brain — store per-brain prompt shapes
  in the registry).

---

## Discipline — so this one actually finishes

The failure mode here is not flaky starts; it's not crossing the last mile.
Rules to prevent that, this time:

1. **One active milestone at a time.** No starting M6 while M2's exit gate is
   red. The tiers exist to be done in order.
2. **Write the exit gate's failing test first.** A milestone isn't "in progress"
   until its acceptance check exists and fails. This is Zeus's own thesis applied
   to building Zeus.
3. **Checkpoint to STATUS.md at every milestone boundary** — measured numbers
   only, never a rating raised by hand.
4. **Cadence:** per change → typecheck + containment + no-GPU suite; per session →
   capability suite on the working brain, record the number; per registry change →
   full re-benchmark (R3); weekly → review the failure corpus, re-rate the table.

## Deliberately NOT doing (anti-scope-creep)
Chasing frontier models on raw reasoning · prompt-tuning for today's specific
models · UI polish before the verification layer exists · selling it.

---

## One-screen summary

| Milestone | Delivers | Exit gate | Finish line |
|---|---|---|---|
| M0 | desk cleared | no orphans; serve boots | — |
| **M1** | **acceptance gate + cross-brain check + retry + measured roles** | **capability 100% @ repeat-3, ≥2 brains** | keystone |
| M2 | no-GPU test path + replay corpus | `bun test` green headless | multiplier |
| M3 | every command run e2e | e2e test per command | — |
| M4 | shell + network containment | adversarial suite = **B5** | **① daily-use done** |
| M5 | the ratchet (R1/R2/R3) | regression auto-blocked; roles auto-re-derived | — |
| M6 | persistent tools + race-to-green + continuity | tool reused unprompted; **B3** | compounding edge |
| M7 | escalation ladder + speculative decomposition | speed↑ at equal reliability | — |
| M8 | Zeus improves Zeus + adversary + verified autonomy | self-change under own gates; **B4** | — |
| M9 | composable workflows + multi-modal | random new domain, no recipe | — |
| MR1–MR3 | mixed roster (cloud thinks, local acts) | **B2** cold-swap | **② best-in-class** |

**Best-in-class = B1–B5 all green.** B5 at M4, B3 at M6, B4 at M8, B2 at MR3, and
B1 rolls up once the capability suite holds at repeat-5 across ≥3 brains (M5+).
