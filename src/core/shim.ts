import type { Brain } from '../registry/schema.ts'
import type { ChatRequest, Message, StreamEvent, ToolDef } from '../adapters/types.ts'

/**
 * Tool-calling for brains that have no tool-calling.
 *
 * A large share of interesting models — most notably fine-tunes and abliterated
 * builds — either reject a `tools` parameter outright or silently ignore it.
 * Those models are often excellent at code, and refusing to use them would make
 * "any brain" a slogan rather than a fact.
 *
 * So when a brain cannot call tools natively, Zeus teaches it to. The tool
 * schemas are rendered into the system prompt, the model is asked to emit a
 * fenced JSON action block, and the reply is parsed back into the same
 * `tool_use` events a native brain would have produced. Everything above this
 * layer is unaware of the difference.
 *
 * This is strictly a fallback. Native tool calling is more reliable and is
 * always preferred when the probe says it works.
 */

/**
 * Markers must not collide with Markdown fences. An earlier version opened with
 * "```zeus-action" and used "```" as the stop sequence — which is a prefix of
 * the opening marker, so generation halted the instant the model began an
 * action block and no tool could ever be called.
 */
const OPEN = '<zeus:action>'
const CLOSE = '</zeus:action>'

export function shimSystemPrompt(tools: ToolDef[], base?: string): string {
  const specs = tools
    .map(t => `### ${t.name}\n${t.description}\nParameters (JSON Schema):\n${JSON.stringify(t.parameters, null, 2)}`)
    .join('\n\n')

  const example = tools[0]
    ? `${OPEN}{"tool": "${tools[0].name}", "input": {}}${CLOSE}`
    : `${OPEN}{"tool": "name", "input": {}}${CLOSE}`

  return `${base ? base + '\n\n' : ''}## Calling tools

You have no direct tool-calling channel, so you call a tool by writing an action block.

To use a tool, write exactly this and then stop:

${OPEN}{"tool": "<tool name>", "input": { ...arguments... }}${CLOSE}

For example:

${example}

Rules:
- One action block per reply. Write nothing after ${CLOSE}.
- Inside the block: a single valid JSON object with "tool" and "input" keys, nothing else.
- "input" must satisfy that tool's JSON Schema exactly. Do not invent parameters.
- Escape quotes and newlines properly — the JSON must parse.
- If you do not need a tool, reply in prose with no action block.
- After a tool runs you are given its result and you continue.

## Available tools

${specs}`
}

/** Extract an action block from accumulated model text, if one is present and complete. */
export function parseAction(text: string): { name: string; input: unknown } | undefined {
  const start = text.indexOf(OPEN)
  if (start === -1) return undefined
  const bodyStart = start + OPEN.length
  const end = text.indexOf(CLOSE, bodyStart)
  if (end === -1) return undefined // block still streaming

  const raw = text.slice(bodyStart, end).trim()
  if (!raw) return undefined

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Models sometimes append prose inside the fence. Try the first balanced object.
    const salvaged = firstJsonObject(raw)
    if (!salvaged) return undefined
    try {
      parsed = JSON.parse(salvaged)
    } catch {
      return undefined
    }
  }

  if (!parsed || typeof parsed.tool !== 'string') return undefined
  return { name: parsed.tool, input: parsed.input ?? {} }
}

/** Scan for the first balanced {...} run, respecting strings and escapes. */
function firstJsonObject(s: string): string | undefined {
  const start = s.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return undefined
}

/** Strip any action block from text so the user never sees the wire protocol. */
export function stripAction(text: string): string {
  const start = text.indexOf(OPEN)
  if (start === -1) return text
  return text.slice(0, start).trimEnd()
}

/**
 * Rewrite a request so a non-tool-calling brain can still act.
 * Tool results are folded back in as ordinary user turns.
 */
export function shimRequest(req: ChatRequest): ChatRequest {
  if (!req.tools?.length) return req

  const messages: Message[] = req.messages.map(m => {
    const results = m.content.filter(c => c.type === 'tool_result')
    if (results.length === 0) return m
    // A brain without tool support has no 'tool' role; deliver results as user text.
    return {
      role: 'user',
      content: results.map(r =>
        r.type === 'tool_result'
          ? {
              type: 'text' as const,
              text: r.isError
                ? `Tool error:\n${r.content}\n\nAdjust your approach and continue.`
                : `Tool result:\n${r.content}\n\nContinue.`,
            }
          : { type: 'text' as const, text: '' },
      ),
    }
  })

  return {
    ...req,
    messages,
    system: shimSystemPrompt(req.tools, req.system),
    tools: undefined,
    // Stop at the closing marker: anything past it would be the model inventing
    // the tool's result. The marker is distinct from the opening one, so this
    // cannot truncate the block it is meant to terminate.
    stopSequences: [...(req.stopSequences ?? []), CLOSE],
  }
}

/**
 * Wrap a raw text stream, converting emitted action blocks into tool_use events.
 * Text before an action block is passed through; the block itself is suppressed.
 */
export async function* shimStream(source: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
  let buffer = ''
  let emittedUpTo = 0
  let actionFired = false

  /** Text the user should see: everything before the action block, never the block itself. */
  const visibleEnd = (): number => {
    const start = buffer.indexOf(OPEN)
    return start === -1 ? Math.max(0, buffer.length - OPEN.length) : start
  }

  for await (const ev of source) {
    if (ev.type === 'text') {
      buffer += ev.text
      if (actionFired) continue

      const safe = visibleEnd()
      if (safe > emittedUpTo) {
        yield { type: 'text', text: buffer.slice(emittedUpTo, safe) }
        emittedUpTo = safe
      }

      const action = parseAction(buffer)
      if (action) {
        actionFired = true
        yield { type: 'tool_use', id: crypto.randomUUID(), name: action.name, input: action.input }
      }
      continue
    }

    if (ev.type !== 'done') {
      yield ev
      continue
    }

    // The stop sequence consumes the closing marker, so a finished block arrives
    // without it. Re-add it before the last parse attempt.
    if (!actionFired) {
      const action = parseAction(buffer + CLOSE)
      if (action) {
        actionFired = true
        const start = buffer.indexOf(OPEN)
        const tail = buffer.slice(emittedUpTo, start === -1 ? buffer.length : start)
        if (tail.trim()) yield { type: 'text', text: tail }
        yield { type: 'tool_use', id: crypto.randomUUID(), name: action.name, input: action.input }
      } else {
        // No action after all — this was ordinary prose, so release the tail.
        const tail = buffer.slice(emittedUpTo)
        if (tail) yield { type: 'text', text: tail }
      }
    }

    yield actionFired ? { ...ev, stopReason: 'tool_use' } : ev
  }
}

/**
 * Recover a tool call a brain emitted as plain text.
 *
 * Smaller models routinely announce a tool call in prose instead of using the
 * native channel — sometimes in the same session where the channel worked. The
 * intent is unambiguous and throwing it away wastes the turn, so Zeus reads the
 * common shapes and recovers the call.
 *
 * Formats seen in the wild, all handled here:
 *   {"name": "x", "parameters": {...}}     {"name": "x", "arguments": {...}}
 *   {"tool": "x", "input": {...}}          {"function": "x", "args": {...}}
 *   <tool_call>{...}</tool_call>           ```json { ... } ```
 *
 * @param known  Tool names that actually exist, so prose that merely looks like
 *               JSON is not mistaken for a call.
 */
export function salvageToolCalls(text: string, known: Set<string>): Array<{ name: string; input: unknown }> {
  const found: Array<{ name: string; input: unknown }> = []
  const seen = new Set<string>()

  const candidates: string[] = []

  // Qwen/Hermes-style explicit wrapper.
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    if (m[1]) candidates.push(m[1].trim())
  }
  // Fenced blocks, with or without a language tag.
  for (const m of text.matchAll(/```(?:json|tool_code|python)?\s*([\s\S]*?)```/g)) {
    if (m[1]) candidates.push(m[1].trim())
  }
  // Bare objects anywhere in the text.
  let idx = 0
  while (idx < text.length && candidates.length < 24) {
    const start = text.indexOf('{', idx)
    if (start === -1) break
    const obj = balancedObject(text, start)
    if (!obj) break
    candidates.push(obj)
    idx = start + obj.length
  }

  for (const raw of candidates) {
    const inner = raw.startsWith('{') ? raw : (balancedObject(raw, raw.indexOf('{')) ?? '')
    if (!inner) continue

    let parsed: any
    try {
      parsed = JSON.parse(inner)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue

    const name = parsed.name ?? parsed.tool ?? parsed.function ?? parsed.tool_name
    if (typeof name !== 'string' || !known.has(name)) continue

    const input = parsed.parameters ?? parsed.arguments ?? parsed.input ?? parsed.args ?? parsed.params ?? {}
    const key = `${name}:${JSON.stringify(input)}`
    if (seen.has(key)) continue // models often repeat the same call twice
    seen.add(key)
    found.push({ name, input })
  }

  return found
}

/** Read one balanced {...} starting at `from`, respecting strings and escapes. */
function balancedObject(s: string, from: number): string | undefined {
  if (from < 0 || s[from] !== '{') return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!
    if (esc) {
      esc = false
      continue
    }
    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(from, i + 1)
    }
  }
  return undefined
}

/** Should this brain be shimmed? Driven by what the probe actually measured. */
export function needsShim(brain: Brain): boolean {
  if (brain.kind !== 'chat') return false
  // An escape hatch for brains whose native tool calling is present but flaky —
  // and for testing the shim path itself.
  if (process.env.ZEUS_FORCE_SHIM) return true
  // Unprobed brains are given the benefit of the doubt; the router demotes them
  // to the shim automatically if a native tool call fails.
  return brain.probed?.reachable === true && brain.probed.toolCalls === false
}
