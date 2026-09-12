import type { Brain } from '../registry/schema.ts'
import { resolveAuth } from '../registry/registry.ts'
import { costOf, type ChatAdapter, type ChatRequest, type Message, type StreamEvent } from './types.ts'

/**
 * Google's Generative Language API.
 *
 * A third distinct shape: roles are "user" and "model", content is "parts",
 * tools are wrapped in a functionDeclarations array, and the stream is a JSON
 * array of chunks rather than typed SSE events.
 */

function toContents(messages: Message[]) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.content
      .map(c => {
        switch (c.type) {
          case 'text':
            return { text: c.text }
          case 'image':
            return { inlineData: { mimeType: c.mediaType, data: c.data } }
          case 'tool_use':
            return { functionCall: { name: c.name, args: c.input ?? {} } }
          case 'tool_result':
            return {
              functionResponse: {
                name: c.toolUseId,
                response: { result: c.content, ...(c.isError ? { error: true } : {}) },
              },
            }
        }
      })
      .filter(Boolean),
  }))
}

/** Gemini rejects unknown JSON Schema keywords, so pass only what it accepts. */
function cleanSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  const allowed = ['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable']
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (!allowed.includes(k)) continue
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as any).map(([p, s]) => [p, cleanSchema(s)])) : cleanSchema(v)
  }
  return out
}

export const gemini: ChatAdapter = {
  name: 'gemini',

  async *chat(brain: Brain, req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const key = resolveAuth(brain)
    if (!key) {
      yield { type: 'error', message: `Brain "${brain.id}" needs an API key — set auth: env:YOUR_VAR in the registry.` }
      return
    }

    const base = brain.endpoint.replace(/\/$/, '')
    const url = `${base}/models/${encodeURIComponent(brain.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`

    const payload: Record<string, unknown> = {
      contents: toContents(req.messages),
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.stopSequences?.length ? { stopSequences: req.stopSequences } : {}),
      },
    }
    if (req.system) payload.systemInstruction = { parts: [{ text: req.system }] }
    if (req.tools?.length) {
      payload.tools = [
        {
          functionDeclarations: req.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: cleanSchema(t.parameters),
          })),
        },
      ]
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (e) {
      yield { type: 'error', message: `${brain.id}: cannot reach Gemini — ${(e as Error).message}` }
      return
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      yield { type: 'error', message: `${brain.id}: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 400)}` : ''}` }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopReason = 'end_turn'
    const usage = { inputTokens: 0, outputTokens: 0 }

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

          let chunk: any
          try {
            chunk = JSON.parse(line.slice(5).trim())
          } catch {
            continue
          }

          if (chunk.usageMetadata) {
            usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens
            usage.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens
          }

          const candidate = chunk.candidates?.[0]
          if (!candidate) continue
          if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            stopReason = String(candidate.finishReason).toLowerCase()
          }

          for (const part of candidate.content?.parts ?? []) {
            if (part.text) yield { type: 'text', text: part.text }
            if (part.functionCall) {
              stopReason = 'tool_use'
              yield {
                type: 'tool_use',
                id: crypto.randomUUID(),
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
              }
            }
          }
        }
      }
    } catch (e) {
      yield { type: 'error', message: `${brain.id}: stream failed — ${(e as Error).message}` }
      return
    } finally {
      reader.releaseLock()
    }

    yield { type: 'done', stopReason, usage: { ...usage, costUsd: costOf(brain, usage) } }
  },
}
