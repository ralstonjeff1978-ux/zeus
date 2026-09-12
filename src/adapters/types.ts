import type { Brain } from '../registry/schema.ts'

/**
 * The normalized shape every brain is spoken to through.
 *
 * Adapters translate this to and from whatever wire format a provider wants.
 * Nothing above this layer knows which vendor it is talking to.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string } // base64
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export type Message = { role: Role; content: ContentPart[] }

export type ToolDef = {
  name: string
  description: string
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>
}

export type ChatRequest = {
  messages: Message[]
  system?: string
  tools?: ToolDef[]
  maxTokens?: number
  temperature?: number
  stopSequences?: string[]
}

export type Usage = {
  inputTokens?: number
  outputTokens?: number
  /** USD, computed by Zeus from the registry price — never trusted from the provider. */
  costUsd?: number
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'done'; stopReason: string; usage: Usage }
  | { type: 'error'; message: string }

export type EmbedRequest = { input: string[] }
export type EmbedResponse = { vectors: number[][]; usage: Usage }

export interface ChatAdapter {
  readonly name: string
  chat(brain: Brain, req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
}

export interface EmbedAdapter {
  readonly name: string
  embed(brain: Brain, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse>
}

/** Compute cost from the registry's declared price. Zeus is the source of truth. */
export function costOf(brain: Brain, usage: Usage): number {
  const inTok = usage.inputTokens ?? 0
  const outTok = usage.outputTokens ?? 0
  return (inTok / 1e6) * brain.price.in + (outTok / 1e6) * brain.price.out
}
