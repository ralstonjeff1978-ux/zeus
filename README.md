# Zeus

A universal, local-first AI engineering tool. Point it at any brain — local or
cloud — and it does real work on your machine: writes code, fixes machines,
designs hardware, researches, and produces finished documents.

**No model is hardcoded.** Zeus's source contains zero model names. Every brain
lives in `brains.yaml`, which you own.

**No telemetry.** No analytics, no feature flags, no update checks. Zeus runs
air-gapped. The egress ledger exists so *you* can audit what left the machine —
it never blocks a call, and it is never transmitted.

---

## Quick start

```powershell
bun install
bun run src/index.ts discover --save     # find your local models
bun run src/index.ts test --all          # find out what they can actually do
bun run scripts/assign-roles.ts          # assign coder/architect/reviewer roles
bun run src/index.ts do "fix the failing test in src/parser.ts"
```

Add to PATH for a bare `zeus` command, or alias it:

```powershell
function zeus { bun run F:\zeus\src\index.ts @args }
```

---

## Brains

```yaml
- id: coder
  label: Qwen3 Coder 30B
  kind: chat                      # chat image video audio embed transcribe
  adapter: openai-compat          # covers Ollama, LM Studio, llama.cpp, vLLM,
  endpoint: http://localhost:11434/v1   # OpenRouter, Groq, xAI, DeepSeek, OpenAI…
  model: qwen3-coder:30b
  auth: none                      # or env:YOUR_API_KEY — never a literal secret
  locality: local                 # a label for grouping, never a gate
  roles: [coder]
  price: {in: 0, out: 0}
```

`zeus discover --save` writes this for you from whatever is running locally.
Adding a cloud brain is the same eight lines with a different endpoint.

`locality` never blocks anything. Cloud brains work exactly like local ones; the
label just groups them in the selector and marks the ledger honestly.

### Probing, not trusting

`zeus test --all` sends a real request to each brain and records what came back:
streaming, tool calls, latency. Declared capability lies — a great many models
reject tool calls outright, and you want to know that before you are three turns
into a task.

### The tool-call shim

Brains that cannot call tools are still fully usable. Zeus renders the tool
schemas into the prompt, asks for a `<zeus:action>` block, and parses the reply
back into ordinary tool-call events. Nothing above the router can tell the
difference. This is what makes "any brain" a fact rather than a slogan.

Zeus also recovers tool calls that a model announces in prose — a common failure
in smaller models, including ones whose native tool calling probed fine.

---

## Commands

| | |
|---|---|
| `zeus brains` | list brains, grouped local and cloud |
| `zeus discover --save` | find local inference servers and register their models |
| `zeus test --all` | probe what each brain can really do |
| `zeus ask <id> <prompt>` | one prompt, one brain |
| `zeus do <task>` | run the agent on a task |
| `zeus swarm <prompt>` | several brains answer, a different one judges |
| `zeus consensus <prompt>` | independent answers, no judge — disagreement is the signal |
| `zeus pipe <name> <goal>` | brains in series, each building on the last |
| `zeus race <task>` | brains attempt the same code change in isolated worktrees |
| `zeus job start <recipe> <goal>` | begin long, resumable work |
| `zeus job run <id>` | run or resume it |
| `zeus serve` | Anthropic-shaped endpoint over your whole registry |
| `zeus checkpoint create/diff/restore` | snapshot and roll back agent edits |
| `zeus ledger` | what left this machine |

### Permission modes

`--mode ask` (default) · `auto-edit` · `auto` · `readonly`

Path containment is enforced in the tools, not in the prompt. An agent cannot
write outside its allowed roots regardless of what it is told.

---

## Jobs — work too large for a context window

A job is a tree of small steps in SQLite, each fitting comfortably in a window,
with results written to disk as they complete. Stop after step 40; resume next
week at step 41.

```powershell
zeus job start design "a 12V solar charge controller for a 100Ah LiFePO4 bank"
zeus job run design-m3k2p1-a4f9
zeus job improve design-m3k2p1-a4f9    # another adversarial review pass
```

| Recipe | Steps |
|---|---|
| `design` | brief → subsystem specs → integration → costed BOM → adversarial review → revision → build instructions → document |
| `book` | outline → story bible → per-chapter drafting → continuity pass → manuscript |
| `research` | scope → parallel enquiry → synthesis → fact-check by a second brain |

**The critique step is the point.** A brain reviewing its own work grades
generously; a second brain told to find what is wrong finds considerably more.

---

## Swarm

`zeus swarm` runs several brains on the same task and has a **different** brain
judge, with answers anonymised and shuffled so the judge cannot favour an author
it recognises. This is how modest local models are made to punch above their
weight.

`zeus consensus` skips the judge and shows you every answer. Where independent
brains disagree is exactly where a human should look — built for bug hunting.

### Pipelines — brains in series

A tournament reduces variance. A pipeline adds stages of thought.

```powershell
zeus pipe build "a CLI that watches a folder and thumbnails new images"
zeus pipe research "what actually killed the Concorde programme"
zeus pipe critique "$(Get-Content .\design.md -Raw)"
```

| Pipeline | Stages |
|---|---|
| `build` | architect plans → coder builds → reviewer critiques → coder revises |
| `research` | scope → investigate → fact-check by a second brain → synthesise |
| `critique` | analyse → attack the analysis → final judgement |

Stages are addressed by **role**, never by model name, so a pipeline written
today still runs after you have replaced every model in the registry. The
revision stage is skipped when the reviewer reports nothing wrong.

### Racing — brains in parallel, on real code

```powershell
zeus race "make the CSV parser handle quoted commas" --verify "bun test"
```

Each brain gets its own git worktree branched from HEAD, works in isolation,
and the resulting **diffs** are judged against each other. Verification outranks
the judge: a diff that fails `--verify` cannot beat one that passes, whatever an
opinion says about its style. The winner is applied to your tree as ordinary
uncommitted changes — nothing is committed on an agent's say-so, and your
working tree is untouched until you say yes.

---

## Router mode

```powershell
zeus serve --port 8787
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"
```

Any Anthropic-compatible client now drives your entire registry, with failover,
the shim and cost accounting applied, without knowing any of it happened. Ask
for a brain by its Zeus id as the model name.

---

## Extending

- **MCP** — `mcp_connect` attaches any Model Context Protocol server at runtime
  and its tools become Zeus tools. This is the escape hatch for anything not
  built in.
- **Acquisition** — Zeus checks whether a tool exists (`check_capability`) and
  can install it (`install_capability`) via winget, scoop, choco, npm, pip,
  cargo, or `git clone`. Every install shows the exact command and asks first.

---

## What Zeus does not do

It routes, orchestrates, verifies and renders. It does not make a brain smarter
than it is. A 30B local model with excellent tooling is still a 30B model — the
swarm narrows that gap by consensus and adversarial review, but does not close it.

Where correctness genuinely matters — circuit design, structural loads, security
findings — the answer is verification against something real: a simulator, a test
suite, a datasheet. Zeus is built to call those, and to say plainly when none was
available.
