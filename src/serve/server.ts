import type { RegistryFile } from '../registry/schema.ts'
import { route } from '../core/router.ts'
import type { ChatRequest, ContentPart, Message, ToolDef } from '../adapters/types.ts'

/**
 * Router mode.
 *
 * Zeus exposes an Anthropic-shaped Messages endpoint and serves it from any
 * brain in the registry. Point any tool that speaks that protocol at Zeus by
 * setting ANTHROPIC_BASE_URL, and it drives your local models, your cloud
 * models, and the failover ladder between them — without knowing any of that
 * happened.
 *
 * The requested `model` is treated as a Zeus brain id, so the client's model
 * picker becomes a brain picker.
 */

export type ServeOptions = {
  registry: RegistryFile
  port: number
  host?: string
  /** Brain used when the client asks for one Zeus does not have. */
  fallbackBrain?: string
  /** Ordered ids tried when the chosen brain fails. */
  fallbacks?: string[]
  onLog?: (line: string) => void
}

/** Anthropic content blocks in, Zeus content parts out. */
function fromAnthropicContent(content: unknown): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out: ContentPart[] = []
  for (const block of content as any[]) {
    switch (block?.type) {
      case 'text':
        out.push({ type: 'text', text: String(block.text ?? '') })
        break
      case 'image':
        if (block.source?.type === 'base64') {
          out.push({ type: 'image', mediaType: String(block.source.media_type ?? 'image/png'), data: String(block.source.data ?? '') })
        }
        break
      case 'tool_use':
        out.push({ type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input ?? {} })
        break
      case 'tool_result':
        out.push({
          type: 'tool_result',
          toolUseId: String(block.tool_use_id ?? ''),
          content:
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => c?.text ?? '').join('\n')
                : JSON.stringify(block.content ?? ''),
          ...(block.is_error ? { isError: true } : {}),
        })
        break
    }
  }
  return out
}

function toChatRequest(body: any): ChatRequest {
  const messages: Message[] = (body.messages ?? []).map((m: any) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: fromAnthropicContent(m.content),
  }))

  const system =
    typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((s: any) => s?.text ?? '').join('\n')
        : undefined

  const tools: ToolDef[] | undefined = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t?.name)
        .map((t: any) => ({
          name: String(t.name),
          description: String(t.description ?? ''),
          parameters: t.input_schema ?? { type: 'object', properties: {} },
        }))
    : undefined

  return {
    messages,
    system,
    tools,
    maxTokens: body.max_tokens ?? 4096,
    temperature: body.temperature,
    stopSequences: body.stop_sequences,
  }
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export function createServer(opts: ServeOptions) {
  const log = opts.onLog ?? (() => {})

  return Bun.serve({
    port: opts.port,
    hostname: opts.host ?? '127.0.0.1',
    idleTimeout: 255,

    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/health') {
        return Response.json({ ok: true, brains: opts.registry.brains.length })
      }

      // Clients discover available models here; Zeus answers with its brains.
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return Response.json({
          data: opts.registry.brains
            .filter(b => b.kind === 'chat')
            .map(b => ({
              id: b.id,
              type: 'model',
              display_name: b.label,
              created_at: new Date().toISOString(),
            })),
        })
      }

      if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
        return new Response('Not found', { status: 404 })
      }

      let body: any
      try {
        body = await req.json()
      } catch {
        return Response.json(
          { type: 'error', error: { type: 'invalid_request_error', message: 'Body is not valid JSON' } },
          { status: 400 },
        )
      }

      const requested = String(body.model ?? '')
      const known = opts.registry.brains.some(b => b.id === requested)
      const brainId = known ? requested : (opts.fallbackBrain ?? opts.registry.default)

      if (!brainId) {
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                `Zeus has no brain "${requested}" and no default is set. ` +
                `Known brains: ${opts.registry.brains.map(b => b.id).join(', ')}`,
            },
          },
          { status: 404 },
        )
      }
      if (!known) log(`model "${requested}" is not a Zeus brain — serving from ${brainId}`)

      const chatReq = toChatRequest(body)
      const wantsStream = body.stream === true
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`

      if (!wantsStream) {
        const content: any[] = []
        let text = ''
        let stopReason = 'end_turn'
        let usage = { input_tokens: 0, output_tokens: 0 }
        let failure: string | undefined

        for await (const ev of route(opts.registry, { by: 'id', id: brainId }, chatReq, {
          fallbacks: opts.fallbacks,
          context: 'serve',
        })) {
          if (ev.type === 'text') text += ev.text
          else if (ev.type === 'tool_use') content.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input })
          else if (ev.type === 'done') {
            stopReason = ev.stopReason === 'tool_use' ? 'tool_use' : 'end_turn'
            usage = { input_tokens: ev.usage.inputTokens ?? 0, output_tokens: ev.usage.outputTokens ?? 0 }
          } else if (ev.type === 'error') failure = ev.message
        }

        if (failure) {
          return Response.json(
            { type: 'error', error: { type: 'api_error', message: failure } },
            { status: 502 },
          )
        }
        if (text) content.unshift({ type: 'text', text })

        return Response.json({
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: brainId,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage,
        })
      }

      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sse(event, data)))
          let blockIndex = 0
          let textOpen = false
          let outputTokens = 0
          let inputTokens = 0
          let stopReason = 'end_turn'

          send('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: brainId,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })

          try {
            for await (const ev of route(opts.registry, { by: 'id', id: brainId }, chatReq, {
              fallbacks: opts.fallbacks,
              context: 'serve',
            })) {
              if (ev.type === 'text') {
                if (!textOpen) {
                  send('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'text', text: '' },
                  })
                  textOpen = true
                }
                send('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: ev.text },
                })
              } else if (ev.type === 'tool_use') {
                if (textOpen) {
                  send('content_block_stop', { type: 'content_block_stop', index: blockIndex })
                  blockIndex++
                  textOpen = false
                }
                send('content_block_start', {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} },
                })
                send('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(ev.input) },
                })
                send('content_block_stop', { type: 'content_block_stop', index: blockIndex })
                blockIndex++
                stopReason = 'tool_use'
              } else if (ev.type === 'done') {
                inputTokens = ev.usage.inputTokens ?? 0
                outputTokens = ev.usage.outputTokens ?? 0
                if (ev.stopReason === 'tool_use') stopReason = 'tool_use'
              } else if (ev.type === 'error') {
                send('error', { type: 'error', error: { type: 'api_error', message: ev.message } })
              }
            }

            if (textOpen) send('content_block_stop', { type: 'content_block_stop', index: blockIndex })
            send('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            })
            send('message_stop', { type: 'message_stop' })
          } catch (e) {
            send('error', { type: 'error', error: { type: 'api_error', message: (e as Error).message } })
          } finally {
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      })
    },
  })
}
