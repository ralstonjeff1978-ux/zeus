# Zeus — current status

Working state. Read this first when picking the work back up.
Strategy and roadmap live in [PLAN.md](PLAN.md); execution order in
[COMPLETION_PLAN.md](COMPLETION_PLAN.md).

---

## 📍 RESUME HERE — 2026-09-02 EOD

**One-liner to restart tomorrow:** *"Open Zeus — read `F:\zeus\STATUS.md` and
`F:\zeus\COMPLETION_PLAN.md`, then continue M0."*

**We are mid-M0 (Clear the desk) of COMPLETION_PLAN.md.** State tonight:

- **Environment:** Ollama lives at
  `C:\Users\Ralst\AppData\Local\AMD\AI_Bundle\Ollama\ollama.exe` and was **DOWN**
  at session start — **start it first** (`& <that path> serve`, or launch the
  Ollama app) and confirm `http://localhost:11434/api/tags` responds before any
  Zeus brain command. Bun still at `C:\Users\Ralst\AppData\Roaming\npm\bun.cmd`.
- ✅ **Env verified** — Bun 1.3.14, typecheck clean.
- ✅ **Orphan job cleared** — `design-msqahjs6-onz5` (USB Desk Lamp) resumed
  **9/13 → 13/13 done**; real deliverables written to
  `.zeus/jobs/design-msqahjs6/` (`design.html` 78KB, `design.md` 66KB). The Job
  Engine's "it survives" edge demonstrated end to end.
- ⚠️ **Coder seat:** `default:` + `coder` role = `qwen3-coder-abliterated-30b`.
  Its `probed.reachable:false` is a **STALE Aug-12 timed-out probe**, NOT proof
  it's dead — **re-probe before concluding** (`zeus test qwen3-coder-abliterated-30b`).
- ⏸️ **Role experiment stopped mid-run** (machine shutdown). Was
  `capability glm-4.7-flash-abliterated qwen3.6-abliterated-35b --repeat=3`;
  incomplete log at `.zeus/coder_role_experiment.log`.

**DECISION made tonight → do this first tomorrow (roster refresh):**
Two newer abliterated brains are **pre-registered in `brains.yaml` as PENDING
PULL** (see the commented block). Live-researched 2026-09-02, not yet measured.
1. `ollama pull huihui_ai/Qwen3.8-abliterated:27b` — 18GB, newest Qwen, **big
   tool-call-reliability jump** (Zeus's #1 measured weakness), fits VRAM fully.
   Candidate for coder / architect / reviewer(vision) / new default.
2. `ollama pull huihui_ai/qwen3-coder-next-abliterated` — newest dedicated coder
   (Qwen3-Coder-Next, 58.7% SWE-bench Verified). *Confirm exact ollama tag on pull.*
Then **probe both** and run the **capability suite `--repeat=3`** across the two
new brains + `glm-4.7-flash` (known-good baseline) → **assign the coder seat by
measurement** (this finishes M0's role step and previews M1.4). Cloud stays
excluded from the coder/tool seats (locked *cloud thinks, local acts*).
These supersede `qwen3.6-35b` + `qwen3-vl-32b` (spill past 24GB, crawl) and the
stale `qwen3-coder-30b`. **Then STOP for review before M1** (the acceptance gate).

**Still-open M0 item:** `zeus serve` boot check (never run end to end).

> NOTE: these are web-sourced candidate claims — per Zeus's own rule (*never
> trust a declared capability, probe it*), they get measured on this machine
> before any seat is rewired. Nothing is assumed better off a webpage.

---

## Environment gotchas

- **Bun is not on PATH.** It lives at
  `C:\Users\Ralst\AppData\Roaming\npm\bun.cmd`. A bare `bun` fails in a fresh
  shell; every command below assumes you resolve it.
- Ollama serves on `localhost:11434`. Models suffixed `-cloud` route through it
  but execute **remotely** — they are not local, whatever the endpoint suggests.
- Cold-loading a ~19GB model takes **60–120s**. Probe timeouts scale with size
  (`60s + 12s/GB`), but a first call after boot will still feel hung.
- A ~23GB model on the 24GB card runs, but crawls. Expect very slow turns.

```powershell
$bun = "C:\Users\Ralst\AppData\Roaming\npm\bun.cmd"
& $bun run src/index.ts --help
```

---

## Build ladder

All six rungs are built.

| Rung | State |
|---|---|
| 1. Run the reference implementation | done |
| 2. Registry + adapters + probe | done |
| 3. Router mode (`zeus serve`) | built, **never run end to end** |
| 4. Selector + egress ledger | done |
| 5. Agent loop + tools | done; reliability is the open problem |
| 6. Swarm | done — `swarm`, `consensus`, `pipe`, `race` |

---

## Proven vs unproven

Nothing below is claimed without a measurement behind it.

### Proven
- **Job resumability.** A job interrupted by a hard power cut resumed at the
  correct step and advanced 2 → 9 of 13. This is the headline capability and it
  works.
- **Containment.** `bun run scripts/sandbox-test.ts` — 7/7 escape vectors refused
  with approval already granted, nothing written outside the root, control write
  still succeeds. **File paths only.**
- **Agent can do real work.** Writes a program, runs it, reports honestly;
  inspects the real machine and gets the right answer.
- **Agent reaches for missing tools.** Calls `check_capability`, then
  `install_capability`, unprompted.

### Unproven — do not assume these work
- `zeus race` — smoke-tested only. Never completed a real race.
- `zeus pipe` — listing works; no pipeline has been run to completion.
- `zeus serve` — never started.
- `zeus job` recipes other than `design`.
- **Shell containment.** File tools are contained; the shell tool is **not**
  known to be. Treat unattended runs as unbounded until tested.

### Known broken / weak
- **Follow-through.** The agent writes a correct program and then does not run
  it, so the artifact never appears while the summary claims success. This is the
  single biggest reliability problem. Phase 1 of PLAN.md addresses it.
- **No fallback after a denied install.** The task is abandoned rather than
  solved another way, even with directive guidance in the denial message.
- **Run-to-run instability.** The same brain on the same prompt produced a
  correct file once and nothing on two other runs. Any single-run measurement is
  weak evidence.

---

## Test commands

```powershell
& $bun run typecheck                              # must stay clean
& $bun run test:sandbox                           # containment, no GPU, seconds
& $bun run test:capability <brainId>              # 4 cases, needs GPU
& $bun run test:capability <a> <b> --repeat=3     # scoreboard + consistency
& $bun run test:capability --all-chat             # every chat brain
```

The capability suite verifies against the machine — it executes the programs,
reads the disk, asks the OS — never against what the model claimed. Installs are
**deliberately denied**, so running it never installs software.

---

## Measurements (2026-08-12)

Capability suite, one run each. **n=1 — weak evidence, see instability above.**

| Brain | Size | Cases |
|---|---|---|
| `glm-4.7-flash-abliterated` | 18.8GB | 3/4 |
| `qwen3.6-abliterated-35b` | 23.9GB | 3/4 |
| `qwen3-coder-abliterated-30b` | 18.6GB | 2/4 |
| `qwen2.5-coder-32b-instruct-abliterated` | 17.9GB | 2/4 |

The brain holding the `coder` role scored **below** two others. Roles were
assigned by `scripts/assign-roles.ts` heuristically, not measured. **Do not
rewire roles on this evidence alone** — confirm with `--repeat=3` first. The
durable fix is Phase 1.2: derive roles from measurement.

These specific results expire the moment the registry changes. The *method* is
what carries over.

---

## Fixed on 2026-08-12

All found by measuring, not by reading code.

1. `TOOL_SETS.code`/`system`/`media` omitted `capabilityTools` while the system
   prompt instructed agents to call them — the agent was told to call tools
   absent from its own schema, which it resolved by refusing.
2. Brain selection used `probed?.reachable === true`, excluding every *untested*
   brain. On a 25-brain registry that left a 3B and a 0.5B and hid every 30B.
   Replaced with `src/registry/candidates.ts`: rank, never exclude.
3. `write_file` reported success for empty content — a 0-byte file came back as
   "✓ Created". Now an error.
4. A stall was reported as `finished`. Now `stalled`, and exits non-zero.
5. `install_capability` failure now names the managers that **actually exist**
   here; it previously said only "try a different manager" and the agent gave up.
6. Denial message is now directive — the task is not cancelled.
7. `race` created worktrees under `<cwd>/.zeus`, i.e. **inside the repo being
   raced on**. Now in the OS temp dir. Found by reading, before it ever ran.

Also fixed: the capability harness's own ground-truth call shelled through
`cmd.exe` with nested quotes, mangled, and failed a **correct** answer. A broken
oracle is worse than none.

---

## Open items

- **Paused job:** `design-msqahjs6-onz5` ("USB Desk Lamp") at 9/13. Resume with
  `& $bun run src/index.ts job run design-msqahjs6-onz5`. Stopped deliberately to
  free VRAM, not failed.
- **Pending decision:** confirm the coder swap with `--repeat=3` on the top two
  brains before changing `brains.yaml`.
- **Next build:** PLAN.md Phase 1 — acceptance gate, then capability-driven role
  assignment.

---

## Locked requirements

Do not re-litigate these; they are settled.

- No model names in Zeus source. Brains live in a user-editable registry.
- Cloud brains are not blocked and not gated. `locality` is a label, not a gate.
- No telemetry, no update checks. The egress ledger is for auditing, never
  blocking.
- Not for sale. Personal use.
- **Privacy:** local and supervised only. No remote or cloud brain drives file
  tools on this machine — which is why the capability suite is never run against
  a cloud brain, however convenient the free VRAM would be.
- The registry is being replaced when the new 2TB drive is installed. Never
  hardcode model names; never invest in tuning for today's specific models.

---

## Planned roster (after the new drive)

Best abliterated local models, plus Ollama Cloud, plus a frontier API brain such
as Grok — best brain per task, including swarm jobs.

The design that squares this with the privacy rule is **cloud thinks, local
acts**: judge, architect and reviewer are text-in/text-out and may be cloud;
coder and anything holding tool access stays local. See the *mixed roster*
section of [PLAN.md](PLAN.md) for the full table and its consequences —
cost multiplication in `race`/`swarm`, the ledger becoming load-bearing, and the
fact that `-cloud` models must be labelled `locality: remote` or the ledger lies.

Grok needs no new adapter: `openai-compat` already covers xAI.
