import type { Brain } from './schema.ts'
import { listOllamaModels } from '../adapters/ollamaNative.ts'

/**
 * Auto-discovery of local inference servers.
 *
 * Zeus asks the machine what it has rather than making the user transcribe it.
 * Discovery only ever proposes entries — the user's registry is not modified
 * without an explicit write.
 */

export type Probe = { label: string; endpoint: string; kind: 'ollama' | 'openai-compat' }

/** Local servers worth checking. Endpoints, not model names — nothing is hardcoded about brains. */
export const LOCAL_SERVERS: Probe[] = [
  { label: 'Ollama', endpoint: 'http://localhost:11434', kind: 'ollama' },
  { label: 'LM Studio', endpoint: 'http://localhost:1234/v1', kind: 'openai-compat' },
  { label: 'llama.cpp', endpoint: 'http://localhost:8080/v1', kind: 'openai-compat' },
  { label: 'vLLM', endpoint: 'http://localhost:8000/v1', kind: 'openai-compat' },
]

const DISCOVERY_TIMEOUT_MS = 2500

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), DISCOVERY_TIMEOUT_MS)
  try {
    return await fn(ctl.signal)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** A conservative id derived from a provider's model name. */
export function slugify(modelName: string): string {
  return modelName
    .replace(/^.*\//, '') // drop the publisher prefix
    .replace(/:latest$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48)
}

/** Guess a role set from the model's name. A hint for the selector, freely overridden. */
function inferRoles(name: string, kind: string): string[] {
  const n = name.toLowerCase()
  const roles: string[] = []
  if (kind === 'embed') return ['embed']
  if (/coder|code/.test(n)) roles.push('coder')
  if (/-vl|vision|llava/.test(n)) roles.push('vision')
  if (/-r1|reason|think/.test(n)) roles.push('reasoner')
  if (/sec|security/.test(n)) roles.push('security')
  if (/orchestrat/.test(n)) roles.push('router')
  return roles.length ? roles : ['general']
}

export type Discovered = { brain: Brain; server: string; fitsVram: boolean | null }

/**
 * @param vramGb  Usable VRAM, used only to annotate whether a local model fits.
 */
export async function discoverLocal(vramGb?: number): Promise<Discovered[]> {
  const found: Discovered[] = []

  for (const server of LOCAL_SERVERS) {
    if (server.kind === 'ollama') {
      const models = await withTimeout(s => listOllamaModels(server.endpoint, s))
      if (!models) continue

      for (const m of models) {
        // Cloud entries carry only a manifest stub on disk, so their reported
        // size describes nothing about what it takes to run them.
        const rawGb = m.isCloud || !m.sizeBytes ? undefined : m.sizeBytes / 1e9
        const sizeGb = rawGb && rawGb >= 0.05 ? Math.round(rawGb * 10) / 10 : undefined
        const isEmbed = /embed/.test(m.name)
        const kind = isEmbed ? ('embed' as const) : ('chat' as const)

        found.push({
          server: server.label,
          // A VRAM verdict only means something for a model that runs on this
          // machine. Cloud models get none.
          fitsVram: m.isCloud || !sizeGb || !vramGb ? null : sizeGb <= vramGb * 0.92,
          brain: {
            id: slugify(m.name),
            label: m.name,
            kind,
            // Embeddings need Ollama's own endpoint; chat rides the /v1 shim.
            adapter: isEmbed ? 'ollama-native' : 'openai-compat',
            endpoint: isEmbed ? server.endpoint : `${server.endpoint}/v1`,
            model: m.name,
            auth: 'none',
            // A -cloud model reaches the daemon over localhost but executes
            // off-machine. Labelling it 'local' would be a lie.
            locality: m.isCloud ? 'remote' : 'local',
            price: { in: 0, out: 0 },
            roles: inferRoles(m.name, kind),
            ...(sizeGb ? { sizeGb } : {}),
            ...(m.isCloud
              ? { notes: 'Ollama Cloud — reached via localhost but executed off-machine.' }
              : {}),
          },
        })
      }
      continue
    }

    // OpenAI-shaped servers expose their catalogue at /models.
    const models = await withTimeout(async s => {
      const res = await fetch(`${server.endpoint.replace(/\/$/, '')}/models`, { signal: s })
      if (!res.ok) throw new Error(String(res.status))
      const json: any = await res.json()
      return (json.data ?? []).map((d: any) => String(d.id))
    })
    if (!models) continue

    for (const id of models) {
      found.push({
        server: server.label,
        fitsVram: null,
        brain: {
          id: slugify(id),
          label: `${id} (${server.label})`,
          kind: 'chat',
          adapter: 'openai-compat',
          endpoint: server.endpoint,
          model: id,
          auth: 'none',
          locality: 'local',
          price: { in: 0, out: 0 },
          roles: inferRoles(id, 'chat'),
        },
      })
    }
  }

  return found
}
