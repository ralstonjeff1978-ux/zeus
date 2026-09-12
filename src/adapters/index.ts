import type { Brain } from '../registry/schema.ts'
import type { ChatAdapter, EmbedAdapter } from './types.ts'
import { openaiCompat } from './openaiCompat.ts'
import { anthropic } from './anthropic.ts'
import { gemini } from './gemini.ts'
import { ollamaNativeEmbed } from './ollamaNative.ts'

/** Adapter resolution. Adding a vendor means adding an adapter, never a special case. */

const CHAT: Record<string, ChatAdapter> = {
  'openai-compat': openaiCompat,
  anthropic,
  gemini,
  // Ollama's /v1 shim is OpenAI-shaped, so chat routes through the same adapter.
  'ollama-native': openaiCompat,
}

const EMBED: Record<string, EmbedAdapter> = {
  'ollama-native': ollamaNativeEmbed,
}

export function chatAdapterFor(brain: Brain): ChatAdapter {
  const a = CHAT[brain.adapter]
  if (!a) {
    throw new Error(
      `Brain "${brain.id}" uses adapter "${brain.adapter}", which cannot do chat. ` +
        `Chat adapters: ${Object.keys(CHAT).join(', ')}`,
    )
  }
  return a
}

export function embedAdapterFor(brain: Brain): EmbedAdapter {
  const a = EMBED[brain.adapter]
  if (!a) {
    throw new Error(
      `Brain "${brain.id}" uses adapter "${brain.adapter}", which cannot embed. ` +
        `Embed adapters: ${Object.keys(EMBED).join(', ')}`,
    )
  }
  return a
}

export * from './types.ts'
