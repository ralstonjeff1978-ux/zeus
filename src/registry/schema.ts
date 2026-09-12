import { z } from 'zod'

/**
 * The brain registry schema.
 *
 * Zeus contains no model names. Every brain Zeus can reach is declared here,
 * in a file the user owns and edits. Adding a brain is a data change, never a
 * code change.
 */

/** What a brain produces. Determines which adapter call shape is used. */
export const BrainKind = z.enum([
  'chat', // text in, text/tool-calls out
  'image', // prompt in, image out
  'video', // prompt in, video out
  'audio', // text in, speech out
  'embed', // text in, vector out
  'transcribe', // audio in, text out
])
export type BrainKind = z.infer<typeof BrainKind>

/** Wire protocol. One adapter can serve many vendors. */
export const Adapter = z.enum([
  'openai-compat', // OpenAI, Ollama /v1, LM Studio, llama.cpp, vLLM, OpenRouter, Groq, xAI, DeepSeek, Mistral, Together
  'anthropic', // Anthropic Messages API
  'gemini', // Google Generative Language API
  'ollama-native', // Ollama's own /api/* — needed for embeddings and some vision paths
  'openai-image', // OpenAI/compatible image generation endpoints
  'comfyui', // local ComfyUI graph execution
])
export type Adapter = z.infer<typeof Adapter>

/**
 * Where the brain physically runs.
 *
 * This is a LABEL, not a gate. Zeus never blocks a remote brain. It exists so
 * the selector can group brains and so the egress ledger can record honestly
 * which calls left the machine.
 */
export const Locality = z.enum(['local', 'remote'])
export type Locality = z.infer<typeof Locality>

/** Capabilities Zeus verifies by probing rather than trusting. */
export const ProbedCapabilities = z.object({
  reachable: z.boolean(),
  streaming: z.boolean().optional(),
  toolCalls: z.boolean().optional(),
  vision: z.boolean().optional(),
  jsonSchema: z.boolean().optional(),
  /** Measured, not declared: ms to first token on a trivial prompt. */
  firstTokenMs: z.number().optional(),
  probedAt: z.string().optional(),
  error: z.string().optional(),
})
export type ProbedCapabilities = z.infer<typeof ProbedCapabilities>

export const Brain = z.object({
  /** Stable handle used on the command line, e.g. `zeus ask coder-30b "..."` */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'id must be alphanumeric with . _ -'),
  /** Human label shown in the selector. */
  label: z.string().min(1),
  kind: BrainKind.default('chat'),
  adapter: Adapter,
  /** Base URL of the API. */
  endpoint: z.string().url(),
  /** The provider's own model identifier, passed through verbatim. */
  model: z.string().min(1),
  /**
   * Auth. `none`, or `env:VAR_NAME` to read from the environment.
   * Secrets are never stored in this file.
   */
  auth: z
    .string()
    .default('none')
    .refine(
      v => v === 'none' || v.startsWith('env:'),
      'auth must be "none" or "env:VAR_NAME" — never a literal secret',
    ),
  locality: Locality,
  /** Max context in tokens, if known. */
  context: z.number().int().positive().optional(),
  /** USD per 1M tokens. Zero for local brains. */
  price: z
    .object({ in: z.number().nonnegative(), out: z.number().nonnegative() })
    .default({ in: 0, out: 0 }),
  /** Free-form routing tags, e.g. [coder, architect, reviewer, cheap, vision]. */
  roles: z.array(z.string()).default([]),
  /** Approximate on-disk/VRAM footprint in GB, for local fit warnings. */
  sizeGb: z.number().positive().optional(),
  /** Populated by `zeus brain test`. Never hand-edited. */
  probed: ProbedCapabilities.optional(),
  notes: z.string().optional(),
})
export type Brain = z.infer<typeof Brain>

export const RegistryFile = z.object({
  version: z.literal(1),
  /** Brain id used when none is specified. */
  default: z.string().optional(),
  brains: z.array(Brain),
})
export type RegistryFile = z.infer<typeof RegistryFile>
