import type { RegistryFile } from '../registry/schema.ts'
import type { ChatRequest, ContentPart, Message, Usage } from '../adapters/types.ts'
import { route, type RouteOptions, type RouteTarget } from '../core/router.ts'
import { salvageToolCalls } from '../core/shim.ts'
import { toolDef, type Tool, type ToolContext } from './tools/index.ts'
import { filterTools, confirmerFor, type Confirmer, type Policy } from './permissions.ts'

/**
 * The agent loop.
 *
 * Send the conversation to a brain; if it asks for tools, run them, append the
 * results, and go round again. The loop is deliberately independent of which
 * brain is serving it — the router handles failover and the tool-call shim, so
 * a model with no native tool support runs through this same loop unchanged.
 */

export type AgentEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_end'; name: string; result: string; isError: boolean }
  | { type: 'turn'; n: number; brainId?: string }
  | { type: 'done'; reason: 'finished' | 'max_turns' | 'stopped' | 'stalled'; summary?: string; usage: Usage }
  | { type: 'error'; message: string }

export type AgentOptions = {
  registry: RegistryFile
  target: RouteTarget
  tools: Tool[]
  policy: Policy
  cwd: string
  allowedRoots: string[]
  systemPrompt: string
  /** How to ask the user to approve an action. */
  ask: Confirmer
  maxTurns?: number
  maxCostUsd?: number
  route?: RouteOptions
  signal?: AbortSignal
}

export const DEFAULT_SYSTEM = `You are Zeus, an engineering agent running on the user's own machine.

You do the work. You are not a chat assistant and you are not advising someone
else who will do it — you have real tools and the task is yours to complete.

How you operate:
- Work in small, verifiable steps. Read before you edit. Check your work after you change it.
- Prefer editing a file over rewriting it. Never invent file contents you have not read.
- When a command or test fails, read the actual error and fix the cause. Do not guess twice in a row.
- If a tool you need is missing, call check_capability, then install_capability to get it.
- If a task is large, break it down and work through the parts. Do not stop at a plan.
- When the task is genuinely complete, call the finish tool with a short summary.

What not to do:
- Do not describe what someone could do instead of doing it.
- Do not say a task is impossible without having attempted it with your tools.
- Do not stop early to ask permission for something the tools already gate for you —
  the permission layer asks the user when it needs to.
- Do not pad, hedge, or restate the request back at the user.

Be honest about outcomes. If something failed, say it failed and why. If you could
not verify a change, say so rather than claiming success. A false report of success
is worse than a reported failure — the user is relying on this to be accurate.`

export async function* runAgent(
  prompt: string,
  opts: AgentOptions,
): AsyncGenerator<AgentEvent, void, void> {
  const tools = filterTools(opts.tools, opts.policy)
  const byName = new Map(tools.map(t => [t.name, t]))

  const ctx: ToolContext = {
    cwd: opts.cwd,
    allowedRoots: opts.allowedRoots,
    confirm: confirmerFor(opts.policy, opts.ask),
    signal: opts.signal,
  }

  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const maxTurns = opts.maxTurns ?? 40
  const total: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  let brainId: string | undefined
  let nudges = 0

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'stopped', usage: total }
      return
    }
    yield { type: 'turn', n: turn, brainId }

    const req: ChatRequest = {
      messages,
      system: opts.systemPrompt,
      tools: tools.map(toolDef),
      maxTokens: 8192,
    }

    const assistant: ContentPart[] = []
    const pending: Array<{ id: string; name: string; input: unknown }> = []
    let sawText = ''
    let errored: string | undefined

    for await (const ev of route(opts.registry, opts.target, req, {
      ...opts.route,
      maxCostUsd: opts.maxCostUsd,
      signal: opts.signal,
      context: opts.route?.context ?? 'agent',
    })) {
      if (ev.brainId) brainId = ev.brainId
      switch (ev.type) {
        case 'text':
          sawText += ev.text
          yield { type: 'text', text: ev.text }
          break
        case 'tool_use':
          pending.push({ id: ev.id, name: ev.name, input: ev.input })
          break
        case 'done':
          total.inputTokens = (total.inputTokens ?? 0) + (ev.usage.inputTokens ?? 0)
          total.outputTokens = (total.outputTokens ?? 0) + (ev.usage.outputTokens ?? 0)
          total.costUsd = (total.costUsd ?? 0) + (ev.usage.costUsd ?? 0)
          break
        case 'error':
          errored = ev.message
          break
      }
    }

    if (errored) {
      yield { type: 'error', message: errored }
      yield { type: 'done', reason: 'stopped', usage: total }
      return
    }

    if (opts.maxCostUsd !== undefined && (total.costUsd ?? 0) > opts.maxCostUsd) {
      yield { type: 'error', message: `Budget of $${opts.maxCostUsd} exhausted.` }
      yield { type: 'done', reason: 'stopped', usage: total }
      return
    }

    // A brain that announced its tool call in prose meant to make it. Recover
    // the intent rather than losing the turn — small models do this constantly,
    // including ones whose native tool calling probed fine.
    let salvaged = false
    if (pending.length === 0 && sawText) {
      for (const call of salvageToolCalls(sawText, new Set(byName.keys()))) {
        pending.push({ id: crypto.randomUUID(), name: call.name, input: call.input })
        salvaged = true
      }
      if (salvaged) {
        // Drop the raw JSON from the transcript so the brain does not learn to
        // repeat the malformed shape.
        sawText = stripToolJson(sawText)
      }
    }

    if (sawText) assistant.push({ type: 'text', text: sawText })
    for (const p of pending) assistant.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input })

    if (pending.length === 0) {
      // A brain that narrates its next action and then stops has not finished —
      // it has stalled. Smaller models do this constantly. Nudge it back into
      // acting rather than accepting an announcement as a result.
      if (looksUnfinished(sawText) && nudges < MAX_NUDGES) {
        nudges++
        messages.push({ role: 'assistant', content: assistant.length ? assistant : [{ type: 'text', text: '…' }] })
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'You described what you were going to do but did not do it. ' +
                'Carry out the next step now by calling a tool. ' +
                'When the whole task is genuinely complete, call the finish tool.',
            },
          ],
        })
        continue
      }

      // Out of nudges and still narrating rather than acting. This is a stall,
      // and calling it 'finished' would report a failure as a success — the
      // exact outcome most likely to be believed, since the summary usually
      // describes the work confidently. Name it for what it is so callers can
      // exit non-zero and tests can tell the difference.
      const stalled = looksUnfinished(sawText)
      yield {
        type: 'done',
        reason: stalled ? 'stalled' : 'finished',
        summary: sawText.trim(),
        usage: total,
      }
      return
    }

    messages.push({ role: 'assistant', content: assistant })

    const results: ContentPart[] = []
    for (const call of pending) {
      const tool = byName.get(call.name)
      if (!tool) {
        const known = [...byName.keys()].join(', ')
        yield { type: 'tool_end', name: call.name, result: `no such tool`, isError: true }
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: `There is no tool named "${call.name}". Available tools: ${known}`,
          isError: true,
        })
        continue
      }

      if (tool.name === 'finish') {
        const summary = String((call.input as any)?.summary ?? sawText.trim())
        yield { type: 'done', reason: 'finished', summary, usage: total }
        return
      }

      yield { type: 'tool_start', name: call.name, input: call.input }
      let out: { content: string; isError?: boolean }
      try {
        out = await tool.run(call.input, ctx)
      } catch (e) {
        out = { content: `Tool threw: ${(e as Error).message}`, isError: true }
      }
      yield { type: 'tool_end', name: call.name, result: out.content, isError: !!out.isError }
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: out.content,
        ...(out.isError ? { isError: true } : {}),
      })
    }

    messages.push({ role: 'user', content: results })
  }

  yield { type: 'done', reason: 'max_turns', usage: total }
}

/** How many times a stalled brain is prodded before its answer is taken as final. */
const MAX_NUDGES = 4

/**
 * Does this reply announce an action rather than report a result?
 *
 * Deliberately conservative: a genuine final answer is usually a statement about
 * what was done, in the past tense. Future-tense narration with no tool call is
 * the signature of a stall.
 */
function looksUnfinished(text: string): boolean {
  const t = text.trim()
  if (!t) return true // silence is never a completed task
  if (t.length > 4000) return false // a long substantive answer is an answer

  return (
    /\b(now|next|let me|I'?ll|I will|I'?m going to|first,? let)\b[^.!?]*\b(create|write|add|run|check|test|read|edit|make|build|implement|verify|examine|look)\b/i.test(
      t,
    ) || /\b(here'?s how|the next step|proceeding to|moving on to)\b/i.test(t)
  )
}

/** Remove recovered tool-call JSON from prose so it is not echoed back as example. */
function stripToolJson(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/```(?:json|tool_code|python)?\s*\{[\s\S]*?\}\s*```/g, '')
    .replace(/^\s*\{\s*"(?:name|tool|function)"[\s\S]*?\}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
