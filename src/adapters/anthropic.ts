import type { Brain } from '../registry/schema.ts'
import { resolveAuth } from '../registry/registry.ts'
import { costOf, type ChatAdapter, type ChatRequest, type Message, type StreamEvent } from './types.ts'

/**
 * The Anthropic Messages wire format.
 *
 * Structurally different from OpenAI's: the system prompt is a top-level field,
 * tool calls are content blocks rather than a side channel, and the stream is a
 * typed event sequence instead of homogeneous deltas.
 */

function toAnthropicMessages(messages: Message[]) {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.map(c => {
        switch (c.type) {
          case 'text':
            return { type: 'text', text: c.text }
          case 'image':
            return { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } }
          case 'tool_use':
            return { type: 'tool_use', id: c.id, name: c.name, input: c.input }
          case 'tool_result':
            return {
              type: 'tool_result',
              tool_use_id: c.toolUseId,
              content: c.content,
              ...(c.isError ? { is_error: true } : {}),
            }
        }
      }),
    }))
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
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
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        try {
          yield JSON.parse(payload)
        } catch {
          /* keep-alive */
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export const anthropic: ChatAdapter = {
  name: 'anthropic',

  async *chat(brain: Brain, req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const token = resolveAuth(brain)
    const url = `${brain.endpoint.replace(/\/$/, '')}/v1/messages`

    const payload: Record<string, unknown> = {
      model: brain.model,
      messages: toAnthropicMessages(req.messages),
      max_tokens: req.maxTokens ?? 4096,
      stream: true,
    }
    if (req.system) payload.system = req.system
    if (req.temperature !== undefined) payload.temperature = req.temperature
    if (req.stopSequences?.length) payload.stop_sequences = req.stopSequences
    if (req.tools?.length) {
      payload.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(token ? { 'x-api-key': token } : {}),
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
      yield { type: 'error', message: `${brain.id}: HTTP ${res.status} from ${url}${detail ? ` — ${detail.slice(0, 400)}` : ''}` }
      return
    }

    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>()
    let stopReason = 'end_turn'
    const usage = { inputTokens: 0, outputTokens: 0 }

    for await (const ev of sseEvents(res.body)) {
      switch (ev.type) {
        case 'message_start':
          usage.inputTokens = ev.message?.usage?.input_tokens ?? 0
          break
        case 'content_block_start':
          blocks.set(ev.index, {
            type: ev.content_block.type,
            id: ev.content_block.id,
            name: ev.content_block.name,
            json: '',
          })
          break
        case 'content_block_delta':
          if (ev.delta.type === 'text_delta') {
            yield { type: 'text', text: ev.delta.text }
          } else if (ev.delta.type === 'input_json_delta') {
            const slot = blocks.get(ev.index)
            if (slot) slot.json += ev.delta.partial_json
          }
          break
        case 'content_block_stop': {
          const slot = blocks.get(ev.index)
          if (slot?.type === 'tool_use') {
            let input: unknown = {}
            try {
              input = slot.json ? JSON.parse(slot.json) : {}
            } catch {
              yield { type: 'error', message: `${brain.id}: tool "${slot.name}" produced unparseable arguments` }
              break
            }
            yield { type: 'tool_use', id: slot.id ?? crypto.randomUUID(), name: slot.name ?? '', input }
          }
          break
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason
          if (ev.usage?.output_tokens) usage.outputTokens = ev.usage.output_tokens
          break
      }
    }

    yield { type: 'done', stopReason, usage: { ...usage, costUsd: costOf(brain, usage) } }
  },
}
