import type { Brain } from '../registry/schema.ts'
import { resolveAuth } from '../registry/registry.ts'

/**
 * Media adapters — image, video, speech and transcription.
 *
 * These are separate from the chat adapters because the request shapes have
 * nothing in common with a conversation. The registry treats them identically:
 * a brain with `kind: image` is selected and routed exactly like a chat brain,
 * it simply lands here instead.
 */

export type ImageRequest = {
  prompt: string
  negative?: string
  width?: number
  height?: number
  count?: number
  seed?: number
  steps?: number
  /** Base64 source image for img2img or editing. */
  initImage?: string
}

export type ImageResult = {
  /** Base64-encoded images, in the provider's native format. */
  images: string[]
  mediaType: string
  seed?: number
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} from ${url}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  }
  return res.json()
}

/**
 * Generate images from whichever backend this brain names.
 * Local generation is slow — several minutes is normal on a consumer GPU — so
 * the timeout is generous rather than optimistic.
 */
export async function generateImage(brain: Brain, req: ImageRequest): Promise<ImageResult> {
  const token = resolveAuth(brain)
  const base = brain.endpoint.replace(/\/$/, '')
  const timeout = brain.locality === 'local' ? 900_000 : 300_000

  switch (brain.adapter) {
    case 'openai-image': {
      const json = await postJson(
        `${base}/images/generations`,
        {
          model: brain.model,
          prompt: req.prompt,
          n: req.count ?? 1,
          size: `${req.width ?? 1024}x${req.height ?? 1024}`,
          response_format: 'b64_json',
        },
        token ? { authorization: `Bearer ${token}` } : {},
        timeout,
      )
      const images = (json.data ?? []).map((d: any) => d.b64_json).filter(Boolean)
      if (!images.length) throw new Error('The provider returned no image data.')
      return { images, mediaType: 'image/png' }
    }

    case 'comfyui': {
      // ComfyUI executes a graph. Zeus passes the workflow through from the
      // brain's notes so the user keeps full control of their own pipeline,
      // substituting the prompt and seed into it.
      const workflowJson = brain.notes
      if (!workflowJson) {
        throw new Error(
          `ComfyUI brain "${brain.id}" has no workflow. Put the exported API-format workflow JSON in its "notes" field; ` +
            `Zeus substitutes %PROMPT%, %NEGATIVE% and %SEED% into it.`,
        )
      }
      const seed = req.seed ?? Math.floor(Math.random() * 2 ** 31)
      const workflow = JSON.parse(
        workflowJson
          .replaceAll('%PROMPT%', JSON.stringify(req.prompt).slice(1, -1))
          .replaceAll('%NEGATIVE%', JSON.stringify(req.negative ?? '').slice(1, -1))
          .replaceAll('%SEED%', String(seed)),
      )

      const queued = await postJson(`${base}/prompt`, { prompt: workflow }, {}, 60_000)
      const promptId = queued.prompt_id
      if (!promptId) throw new Error('ComfyUI did not return a prompt_id.')

      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000))
        const hist = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(30_000) })
        if (!hist.ok) continue
        const data: any = await hist.json()
        const entry = data[promptId]
        if (!entry?.outputs) continue

        const files: Array<{ filename: string; subfolder: string; type: string }> = []
        for (const node of Object.values<any>(entry.outputs)) {
          for (const img of node.images ?? []) files.push(img)
        }
        if (!files.length) continue

        const images: string[] = []
        for (const f of files) {
          const url = `${base}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? '')}&type=${encodeURIComponent(f.type ?? 'output')}`
          const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
          if (r.ok) images.push(Buffer.from(await r.arrayBuffer()).toString('base64'))
        }
        if (images.length) return { images, mediaType: 'image/png', seed }
      }
      throw new Error(`ComfyUI did not finish within ${Math.round(timeout / 1000)}s.`)
    }

    default: {
      // Automatic1111 / Forge / SD.Next all expose this shape.
      const json = await postJson(
        `${base}/sdapi/v1/txt2img`,
        {
          prompt: req.prompt,
          negative_prompt: req.negative ?? '',
          width: req.width ?? 1024,
          height: req.height ?? 1024,
          steps: req.steps ?? 30,
          batch_size: req.count ?? 1,
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        },
        token ? { authorization: `Bearer ${token}` } : {},
        timeout,
      )
      const images = json.images ?? []
      if (!images.length) {
        throw new Error(
          `Brain "${brain.id}" uses adapter "${brain.adapter}", which is not a recognised image backend. ` +
            `Use openai-image, comfyui, or point at an Automatic1111-compatible server.`,
        )
      }
      return { images, mediaType: 'image/png' }
    }
  }
}

export type SpeakRequest = { text: string; voice?: string; speed?: number }

export async function synthesizeSpeech(brain: Brain, req: SpeakRequest): Promise<{ audio: Uint8Array; mediaType: string }> {
  const token = resolveAuth(brain)
  const base = brain.endpoint.replace(/\/$/, '')

  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      model: brain.model,
      input: req.text,
      voice: req.voice ?? 'alloy',
      speed: req.speed ?? 1.0,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} from ${base}/audio/speech${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }
  return { audio: new Uint8Array(await res.arrayBuffer()), mediaType: 'audio/mpeg' }
}

export async function transcribeAudio(
  brain: Brain,
  audio: Uint8Array,
  filename: string,
): Promise<{ text: string }> {
  const token = resolveAuth(brain)
  const base = brain.endpoint.replace(/\/$/, '')

  const form = new FormData()
  form.append('file', new Blob([audio]), filename)
  form.append('model', brain.model)
  form.append('response_format', 'json')

  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
    signal: AbortSignal.timeout(900_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} from ${base}/audio/transcriptions${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }
  const json: any = await res.json()
  return { text: json.text ?? '' }
}
