import type { Brain, ProbedCapabilities } from './schema.ts'
import { chatAdapterFor, embedAdapterFor } from '../adapters/index.ts'
import type { ToolDef } from '../adapters/types.ts'

/**
 * Capability probing.
 *
 * Declared capabilities lie, and a brain that silently ignores tool calls is
 * useless as a coding agent but looks healthy from the outside. Zeus finds out
 * by asking, and records what it measured.
 */

/**
 * A cold local model must be read off disk and pushed into VRAM before it emits
 * anything — tens of gigabytes, which dwarfs any network latency. Remote brains
 * that go quiet are failing, so they get a much shorter leash.
 */
function probeTimeoutMs(brain: Brain): number {
  if (brain.locality !== 'local') return 60_000
  const gb = brain.sizeGb ?? 8
  return Math.min(600_000, 60_000 + gb * 12_000)
}

const PROBE_TOOL: ToolDef = {
  name: 'report_color',
  description: 'Report the colour the user asked about. Call this tool; do not answer in prose.',
  parameters: {
    type: 'object',
    properties: { color: { type: 'string', description: 'The colour name' } },
    required: ['color'],
  },
}

export async function probeBrain(brain: Brain): Promise<ProbedCapabilities> {
  const probedAt = new Date().toISOString()

  if (brain.kind === 'embed') {
    try {
      const adapter = embedAdapterFor(brain)
      const started = performance.now()
      const res = await adapter.embed(brain, { input: ['zeus probe'] })
      return {
        reachable: true,
        firstTokenMs: Math.round(performance.now() - started),
        probedAt,
        ...(res.vectors[0]?.length ? {} : { error: 'returned an empty vector' }),
      }
    } catch (e) {
      return { reachable: false, probedAt, error: (e as Error).message }
    }
  }

  if (brain.kind !== 'chat') {
    // Image/video/audio probing needs its own request shape; not yet implemented.
    return { reachable: false, probedAt, error: `probing not yet implemented for kind "${brain.kind}"` }
  }

  // A brain that rejects tools outright is still a usable brain for prose and
  // code generation. Probe with tools first, then retry plainly so the two
  // failures are never confused with each other.
  const withTools = await runChatProbe(brain, true)
  if (withTools.reachable) return { ...withTools, probedAt }

  if (looksLikeToolRejection(withTools.error)) {
    const plain = await runChatProbe(brain, false)
    return { ...plain, toolCalls: false, probedAt }
  }

  return { ...withTools, probedAt }
}

/** Providers phrase this differently; match the shape rather than one vendor's wording. */
function looksLikeToolRejection(error: string | undefined): boolean {
  if (!error) return false
  return /does not support tools|tool(s)? (are |is )?not supported|unsupported.*tool|no tool support|does not support function/i.test(
    error,
  )
}

async function runChatProbe(brain: Brain, useTools: boolean): Promise<ProbedCapabilities> {
  const adapter = chatAdapterFor(brain)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), probeTimeoutMs(brain))

  const caps: ProbedCapabilities = { reachable: false }
  let sawText = false
  let chunks = 0
  let firstAt: number | undefined
  const started = performance.now()

  try {
    for await (const ev of adapter.chat(
      brain,
      {
        system: 'You are being probed for capabilities. Be terse.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: useTools
                  ? 'What colour is a clear midday sky? Use the report_color tool.'
                  : 'What colour is a clear midday sky? One word.',
              },
            ],
          },
        ],
        ...(useTools ? { tools: [PROBE_TOOL] } : {}),
        maxTokens: 128,
        temperature: 0,
      },
      ctl.signal,
    )) {
      switch (ev.type) {
        case 'text':
          firstAt ??= performance.now()
          sawText = true
          chunks++
          break
        case 'tool_use':
          firstAt ??= performance.now()
          caps.toolCalls = true
          break
        case 'error':
          clearTimeout(timer)
          return { ...caps, reachable: false, error: ev.message }
        case 'done':
          caps.reachable = true
          break
      }
    }
  } catch (e) {
    clearTimeout(timer)
    return { ...caps, reachable: false, error: (e as Error).message }
  }
  clearTimeout(timer)

  // More than one text chunk means the stream really is incremental rather than
  // a single buffered response delivered as one frame.
  caps.streaming = chunks > 1
  if (useTools) caps.toolCalls ??= false
  if (firstAt !== undefined) caps.firstTokenMs = Math.round(firstAt - started)
  if (!caps.reachable && !sawText) caps.error ??= 'stream ended without a completion event'

  return caps
}
