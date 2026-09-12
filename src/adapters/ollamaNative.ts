import type { Brain } from '../registry/schema.ts'
import type { EmbedAdapter, EmbedRequest, EmbedResponse } from './types.ts'

/**
 * Ollama's own API, used where its OpenAI shim is lacking.
 *
 * Embeddings are the case that matters: Zeus's long-form work (retrieval over a
 * manuscript, codebase search) depends on a local embedding brain, and Ollama
 * exposes that at /api/embed rather than through the compat layer.
 */

export const ollamaNativeEmbed: EmbedAdapter = {
  name: 'ollama-native',

  async embed(brain: Brain, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse> {
    const url = `${brain.endpoint.replace(/\/$/, '')}/api/embed`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: brain.model, input: req.input }),
      signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${brain.id}: HTTP ${res.status} from ${url}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
    }
    const json: any = await res.json()
    const vectors: number[][] = json.embeddings ?? []
    if (!vectors.length) throw new Error(`${brain.id}: embedding response contained no vectors`)
    return {
      vectors,
      usage: { inputTokens: json.prompt_eval_count ?? 0, outputTokens: 0, costUsd: 0 },
    }
  },
}

/** List models an Ollama daemon actually has, for auto-discovery. */
export async function listOllamaModels(
  endpoint: string,
  signal?: AbortSignal,
): Promise<Array<{ name: string; sizeBytes: number; isCloud: boolean }>> {
  const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, { signal })
  if (!res.ok) throw new Error(`Ollama at ${endpoint} returned HTTP ${res.status}`)
  const json: any = await res.json()
  return (json.models ?? []).map((m: any) => ({
    name: m.name,
    sizeBytes: m.size ?? 0,
    // Ollama Cloud models carry a -cloud suffix and occupy no local disk.
    // They route through localhost but execute off-machine.
    isCloud: /-cloud\b|:cloud\b/.test(m.name) || !m.size,
  }))
}
