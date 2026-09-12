import type { Brain } from '../registry/schema.ts'
import { resolveAuth } from '../registry/registry.ts'
import { costOf, type ChatAdapter, type ChatRequest, type Message, type StreamEvent, type ToolDef } from './types.ts'

/**
 * The OpenAI Chat Completions wire format.
 *
 * This single adapter covers the large majority of the field: OpenAI, Ollama's
 * /v1 shim, LM Studio, llama.cpp's server, vLLM, OpenRouter, Groq, xAI,
 * DeepSeek, Mistral and Together all speak it.
 */

type OaiMessage = {
  role: string
  content?: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toOaiMessages(system: string | undefined, messages: Message[]): OaiMessage[] {
  const out: OaiMessage[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    // Tool results are their own role in this format, one message per result.
    const toolResults = m.content.filter(c => c.type === 'tool_result')
    if (toolResults.length > 0) {
      for (const r of toolResults) {
        if (r.type !== 'tool_result') continue
        out.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content })
      }
      continue
    }

    const toolUses = m.content.filter(c => c.type === 'tool_use')
    const text = m.content
      .filter(c => c.type === 'text')
      .map(c => (c.type === 'text' ? c.text : ''))
      .join('')
    const images = m.content.filter(c => c.type === 'image')

    if (toolUses.length > 0) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map(t =>
          t.type === 'tool_use'
            ? { id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.input) } }
            : (undefined as never),
        ),
      })
      continue
    }

    if (images.length > 0) {
      const parts: Array<Record<string, unknown>> = []
      if (text) parts.push({ type: 'text', text })
      for (const img of images) {
        if (img.type !== 'image') continue
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })
      }
      out.push({ role: m.role, content: parts })
      continue
    }

    out.push({ role: m.role, content: text })
  }
  return out
}

function toOaiTools(tools: ToolDef[] | undefined) {
  if (!tools?.length) return undefined
  return tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/** Split an SSE byte stream into `data:` payloads. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export const openaiCompat: ChatAdapter = {
  name: 'openai-compat',

  async *chat(brain: Brain, req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const token = resolveAuth(brain)
    const url = `${brain.endpoint.replace(/\/$/, '')}/chat/completions`

    const payload: Record<string, unknown> = {
      model: brain.model,
      messages: toOaiMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.maxTokens) payload.max_tokens = req.maxTokens
    if (req.temperature !== undefined) payload.temperature = req.temperature
    if (req.stopSequences?.length) payload.stop = req.stopSequences
    const tools = toOaiTools(req.tools)
    if (tools) payload.tools = tools

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (e) {
      yield { type: 'error', message: `${brain.id}: cannot reach ${url} — ${(e as Error).message}` }
      return
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      yield {
        type: 'error',
        message: `${brain.id}: HTTP ${res.status} from ${url}${detail ? ` — ${detail.slice(0, 400)}` : ''}`,
      }
      return
    }

    // Tool call arguments arrive in fragments keyed by index; accumulate them.
    const partial = new Map<number, { id: string; name: string; args: string }>()
    let stopReason = 'end_turn'
    let usage = { inputTokens: 0, outputTokens: 0 }

    for await (const data of sseLines(res.body)) {
      if (data === '[DONE]') break
      let chunk: any
      try {
        chunk = JSON.parse(data)
      } catch {
        continue // keep-alive or comment frame
      }

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue

      const delta = choice.delta
      if (delta?.content) yield { type: 'text', text: delta.content }

      for (const tc of delta?.tool_calls ?? []) {
        const slot = partial.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        partial.set(tc.index, slot)
      }

      if (choice.finish_reason) {
        stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason
      }
    }

    for (const slot of partial.values()) {
      let input: unknown = {}
      try {
        input = slot.args ? JSON.parse(slot.args) : {}
      } catch {
        // A brain that emits malformed tool JSON is a real failure mode worth surfacing.
        yield { type: 'error', message: `${brain.id}: tool "${slot.name}" produced unparseable arguments: ${slot.args.slice(0, 200)}` }
        continue
      }
      yield { type: 'tool_use', id: slot.id || crypto.randomUUID(), name: slot.name, input }
    }

    yield { type: 'done', stopReason, usage: { ...usage, costUsd: costOf(brain, usage) } }
  },
}
