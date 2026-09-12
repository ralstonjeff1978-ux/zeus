import type { Brain, RegistryFile } from '../registry/schema.ts'
import { findBrain } from '../registry/registry.ts'
import { chatAdapterFor } from '../adapters/index.ts'
import type { ChatRequest, StreamEvent, Usage } from '../adapters/types.ts'
import { needsShim, shimRequest, shimStream } from './shim.ts'
import { recordCall } from './ledger.ts'

/**
 * The router.
 *
 * Everything above this layer names a brain, or a role, and gets a stream back.
 * The router decides which brain actually serves the call, retries a failing one,
 * falls down a ladder when a brain is unavailable, shims tool calling where the
 * brain lacks it, and records every call in the egress ledger.
 */

export type RouteTarget =
  | { by: 'id'; id: string }
  /** Pick the best available brain carrying this role. */
  | { by: 'role'; role: string; prefer?: 'local' | 'remote' | 'cheapest' | 'fastest' }

export type RouteOptions = {
  /** Ordered fallbacks tried when the primary fails. Ids, not models. */
  fallbacks?: string[]
  /** Abort the whole route if projected spend exceeds this. */
  maxCostUsd?: number
  /** Label written to the ledger so a call can be traced to its cause. */
  context?: string
  signal?: AbortSignal
  /** Attempts per brain before moving to the next. */
  retries?: number
}

export class BudgetExceeded extends Error {}

/** Transient conditions are worth retrying; a bad request is not. */
function isRetryable(message: string): boolean {
  return /HTTP (429|500|502|503|504)|rate.?limit|overloaded|timeout|ECONNRESET|socket hang up|fetch failed|cannot reach/i.test(
    message,
  )
}

/** A native tool-call rejection means "try again shimmed", not "give up". */
function isToolRejection(message: string): boolean {
  return /does not support tools|tool(s)? (are |is )?not supported|unsupported.*tool|does not support function/i.test(
    message,
  )
}

export function selectBrain(reg: RegistryFile, target: RouteTarget): Brain {
  if (target.by === 'id') return findBrain(reg, target.id)

  const candidates = reg.brains.filter(
    b => b.kind === 'chat' && b.roles.includes(target.role) && b.probed?.reachable !== false,
  )
  if (!candidates.length) {
    throw new Error(
      `No reachable brain carries the role "${target.role}". ` +
        `Tag one in your registry with roles: [${target.role}]`,
    )
  }

  const score = (b: Brain): number => {
    switch (target.prefer) {
      case 'local':
        return b.locality === 'local' ? 0 : 1
      case 'remote':
        return b.locality === 'remote' ? 0 : 1
      case 'cheapest':
        return b.price.in + b.price.out
      case 'fastest':
        return b.probed?.firstTokenMs ?? Number.MAX_SAFE_INTEGER
      default:
        // Prefer a brain that can actually call tools, then a local one.
        return (b.probed?.toolCalls ? 0 : 10) + (b.locality === 'local' ? 0 : 1)
    }
  }
  return candidates.sort((a, b) => score(a) - score(b))[0]!
}

/**
 * Run a chat request, yielding normalized events.
 * Errors from a brain are not yielded as `error` unless every option is exhausted.
 */
export async function* route(
  reg: RegistryFile,
  target: RouteTarget,
  req: ChatRequest,
  opts: RouteOptions = {},
): AsyncIterable<StreamEvent & { brainId?: string }> {
  const primary = selectBrain(reg, target)
  const ladder: Brain[] = [primary]

  for (const id of opts.fallbacks ?? []) {
    try {
      const b = findBrain(reg, id)
      if (!ladder.some(x => x.id === b.id)) ladder.push(b)
    } catch {
      // A fallback that no longer exists should not break the route.
    }
  }

  const failures: string[] = []

  for (const brain of ladder) {
    const attempts = Math.max(1, opts.retries ?? 2)
    let forceShim = needsShim(brain)

    for (let attempt = 0; attempt < attempts; attempt++) {
      const outcome = yield* attemptOnce(brain, req, opts, forceShim)

      if (outcome.ok) return

      failures.push(`${brain.id}: ${outcome.error}`)

      // A brain that rejects tools natively can still work through the shim.
      if (!forceShim && isToolRejection(outcome.error) && req.tools?.length) {
        forceShim = true
        continue
      }
      if (!isRetryable(outcome.error)) break

      // Back off before retrying the same brain.
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt))
    }
  }

  yield {
    type: 'error',
    message:
      `Every brain on the route failed.\n` + failures.map(f => `  - ${f}`).join('\n'),
  }
}

/**
 * One attempt against one brain. Yields its events and reports the outcome to
 * the caller rather than surfacing a recoverable error to the consumer.
 */
async function* attemptOnce(
  brain: Brain,
  req: ChatRequest,
  opts: RouteOptions,
  useShim: boolean,
): AsyncGenerator<StreamEvent & { brainId?: string }, { ok: true } | { ok: false; error: string }> {
  const adapter = chatAdapterFor(brain)
  const effective = useShim ? shimRequest(req) : req
  const bytesSent = Buffer.byteLength(JSON.stringify(effective.messages) + (effective.system ?? ''))
  const started = performance.now()

  let usage: Usage = {}
  let failed: string | undefined
  let produced = false

  const raw = adapter.chat(brain, effective, opts.signal)
  const stream = useShim ? shimStream(raw) : raw

  try {
    for await (const ev of stream) {
      if (ev.type === 'error') {
        failed = ev.message
        break
      }
      if (ev.type === 'done') {
        usage = ev.usage
        if (opts.maxCostUsd !== undefined && (usage.costUsd ?? 0) > opts.maxCostUsd) {
          failed = `call cost $${(usage.costUsd ?? 0).toFixed(4)} exceeded the $${opts.maxCostUsd} cap`
          break
        }
      }
      produced = true
      yield { ...ev, brainId: brain.id }
    }
  } catch (e) {
    failed = (e as Error).message
  }

  recordCall(brain, {
    bytesSent,
    usage,
    durationMs: Math.round(performance.now() - started),
    ok: !failed,
    error: failed,
    context: opts.context,
  })

  if (failed) return { ok: false, error: failed }
  if (!produced) return { ok: false, error: 'brain produced no output' }
  return { ok: true }
}

/** Collect a route into a single string. Convenience for non-interactive callers. */
export async function routeText(
  reg: RegistryFile,
  target: RouteTarget,
  req: ChatRequest,
  opts: RouteOptions = {},
): Promise<{ text: string; usage: Usage; brainId?: string }> {
  let text = ''
  let usage: Usage = {}
  let brainId: string | undefined
  let error: string | undefined

  for await (const ev of route(reg, target, req, opts)) {
    if (ev.brainId) brainId = ev.brainId
    if (ev.type === 'text') text += ev.text
    else if (ev.type === 'done') usage = ev.usage
    else if (ev.type === 'error') error = ev.message
  }
  if (error) throw new Error(error)
  return { text, usage, brainId }
}
