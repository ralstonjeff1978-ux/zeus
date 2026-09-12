# Zeus — Architecture

A universal, local-first AI engineering tool. Zeus is not tied to any model,
vendor, or task domain. It routes work to whatever brain you point it at, gives
that brain real hands on your machine, and keeps long work durable enough to
survive reboots.

Zeus knows itself as Zeus. Nothing in it derives from any other tool.

---

## The five layers

```
┌─────────────────────────────────────────────────────────────┐
│ 5  INTERFACES     CLI · TUI dashboard · API server · MCP    │
├─────────────────────────────────────────────────────────────┤
│ 4  ORCHESTRATION  agent loop · subagents · swarm · jobs     │
├─────────────────────────────────────────────────────────────┤
│ 3  TOOLS          files · shell · code · git · web · media  │
│                   system · data · docs · capability · MCP   │
├─────────────────────────────────────────────────────────────┤
│ 2  ROUTING        brain selection · failover · shim · cost  │
├─────────────────────────────────────────────────────────────┤
│ 1  BRAINS         registry · adapters · discovery · probing │
└─────────────────────────────────────────────────────────────┘
         SAFETY (permissions · containment · ledger · budget)
         cuts vertically through every layer
```

---

## Layer 1 — Brains

Any AI, cloud or local. **No model name appears anywhere in Zeus's source.**
Brains are declared in `brains.yaml`, which you own and edit, and which
`zeus discover` regenerates from what is actually installed.

| Field | Purpose |
|---|---|
| `kind` | `chat` `image` `video` `audio` `embed` `transcribe` `rerank` |
| `adapter` | wire protocol — one adapter serves many vendors |
| `locality` | `local` or `remote`. A label for grouping, never a gate. |
| `roles` | routing tags: `coder` `architect` `reviewer` `vision` `security` … |
| `price` | USD per 1M tokens, used for real cost accounting |
| `probed` | what Zeus **measured**, not what the vendor claimed |

**Adapters**

| Adapter | Covers |
|---|---|
| `openai-compat` | OpenAI, Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq, xAI, DeepSeek, Mistral, Together |
| `anthropic` | Anthropic Messages API |
| `gemini` | Google Generative Language |
| `ollama-native` | embeddings and native Ollama endpoints |
| `openai-image` | DALL·E-shaped image generation |
| `comfyui` | local ComfyUI graphs — SDXL, Flux, video models |
| `whisper` | local or hosted transcription |
| `tts` | Piper / XTTS / hosted speech |

**Probing, not trusting.** Declared capability lies. Zeus sends a real request
and records what came back: streaming, tool-calls, vision, latency to first
token. A brain that rejects tools is recorded as such and is *still usable* —
see the shim.

---

## Layer 2 — Routing

- **Selection** by id, by role, or by preference (`local` / `cheapest` / `fastest`).
- **Failover ladders.** A brain that is rate-limited, overloaded or unreachable
  falls through to the next, automatically, with backoff.
- **The tool-call shim.** Many strong models — most fine-tunes and abliterated
  builds — cannot call tools. Zeus renders the tool schemas into the prompt,
  asks for a fenced JSON action, and parses the reply back into ordinary
  tool-call events. Layers above cannot tell the difference. *This is what makes
  "any brain" true rather than aspirational.*
- **Cost accounting** from the registry's own price table, never the provider's.
- **Egress ledger.** Every call recorded to local SQLite with host, bytes and
  locality. Never blocks. Never transmitted.

---

## Layer 3 — Tools

Brains generate content. Tools produce effects. This is everything Zeus can *do*.

### Files & code
`read_file` `write_file` `edit_file` `append_file` `list_dir` `find_files`
`search_text` `apply_patch` `move_file` `delete_file`

### Code intelligence
`lsp_diagnostics` `lsp_definition` `lsp_references` `format_code` `run_tests`
`detect_project` — recognises the stack and finds its build/test/lint commands

### Shell & process
`powershell` `bash` `background_run` `process_list` `process_kill`

### Version control
`git` (status/diff/log/blame/branch/commit) `git_worktree` `github` (gh CLI)

### Web & acquisition
`fetch_url` `web_search` `check_capability` `install_capability`
Zeus recognises when it lacks a tool and can acquire it — winget, scoop, choco,
npm, pip, cargo, or `git clone`. Every install states the exact command and asks.

### Documents & diagrams
`make_document` (Markdown → HTML/PDF) `make_diagram` (Mermaid/Graphviz → SVG/PNG)
`make_chart` `make_spreadsheet`

### Media
`generate_image` `edit_image` `generate_video` `speak` (TTS) `transcribe`
`ffmpeg` — mux, convert, extract frames

### System & repair
`system_info` `disk_health` `network_diagnose` `service_control` `event_log`
`driver_info` `registry_query`

### Data & memory
`sqlite` `read_data` (csv/json/xlsx) `http_request`
`memory_write` `memory_search` — persistent project knowledge, RAG-indexed with
a local embedding brain

### Extensibility
`mcp_connect` — attach any MCP server and its tools become Zeus tools at runtime.
This is the escape hatch: anything not built in can be added without touching
Zeus's source.

---

## Layer 4 — Orchestration

**Agent loop.** Send, run requested tools, append results, repeat. Brain-agnostic
by construction — the shim means a non-tool-calling model runs this same loop.

**Subagents.** Delegate a bounded task to another brain with its own context
window and its own permission policy. Keeps the main context clean.

**Swarm**
- *Tournament* — N brains attempt the same task, a **different** brain judges,
  answers anonymised and shuffled so the judge cannot favour a familiar author.
  This is how modest local models are made to punch above their weight.
- *Consensus* — independent attempts, agreement reported. Disagreement marks
  exactly what a human should look at. Built for bug hunting.
- *Pipeline* — architect → coders (parallel, each in its own git worktree) →
  reviewer → merge.

**Job engine.** Work too large for any context window: a tree of small steps in
SQLite, each fitting comfortably in a window, results written to disk as they
complete. Stop after step 40, resume next week at step 41.

Recipes supply the steps; the engine supplies durability, routing and accounting.

| Recipe | Steps |
|---|---|
| `design` | brief → subsystem specs → integration → costed BOM → adversarial review → revision → build instructions → rendered document |
| `book` | outline → story bible → per-chapter drafting against compact context → continuity pass → assembled manuscript |
| `research` | question → decomposition → parallel investigation → synthesis → citation check |
| `refactor` | survey → plan → per-file change → test → review |

**The critique step is the point.** A brain reviewing its own work grades
generously. A second brain told to find what is wrong finds considerably more.
Improvement passes stack — `zeus job improve` appends another
critique/revise/render cycle, indefinitely.

---

## Layer 5 — Interfaces

- **CLI** — `zeus do`, `zeus ask`, `zeus job`, `zeus swarm`, `zeus brains`
- **TUI** — live dashboard: brains, active agents, tokens, spend, egress
- **Serve** — Anthropic-shaped endpoint. Point any compatible client at Zeus and
  it drives your whole registry, with failover, without knowing.
- **MCP server** — expose Zeus's own tools to other programs.

---

## Safety

Cuts through every layer, per-agent rather than global.

| Mode | Behaviour |
|---|---|
| `readonly` | nothing may mutate — review and analysis |
| `ask` | confirm before any mutation |
| `auto-edit` | file edits proceed; shell still confirms |
| `auto` | everything proceeds — intended for a worktree it cannot escape |

- **Containment.** Every path argument is resolved and checked against the
  agent's allowed roots. Enforced in the tool, not in the prompt.
- **Destructive-command screen.** A speed bump for accidents, not a sandbox.
  Honest about being one.
- **Checkpoints.** File changes are snapshotted before a run so a bad session
  can be rolled back.
- **Budget caps.** Per-run and per-job dollar ceilings, enforced mid-stream.
- **No phone-home.** Zeus has no telemetry, no analytics, no update check. It
  runs air-gapped. The egress ledger exists so *you* can audit, not so anyone
  else can.

---

## Non-goals, stated honestly

Zeus routes, orchestrates, verifies and renders. It does not make a brain
smarter than it is. A 30B local model with excellent tooling is still a 30B
model — the swarm layer narrows that gap by consensus and adversarial review,
but it does not close it.

Where correctness genuinely matters — circuit design, structural loads, security
findings — the answer is verification against something real (a simulator, a
test suite, a datasheet), not a second opinion from another language model.
Zeus is built to call those verifiers, and to say plainly when none was available.
