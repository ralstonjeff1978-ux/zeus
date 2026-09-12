import type { ToolDef } from '../../adapters/types.ts'

/**
 * The tool contract.
 *
 * A tool is a name, a schema, and a function. Zeus's tools are ordinary async
 * functions with validated input — nothing about them is model-specific, which
 * is what lets the same tool serve a native tool-calling brain and a shimmed one.
 */

export type ToolContext = {
  /** Directory the agent is scoped to. Path arguments resolve against it. */
  cwd: string
  /** Roots the agent may touch. A tool must refuse anything outside them. */
  allowedRoots: string[]
  /** Ask before doing something consequential. Returns false to deny. */
  confirm: (action: string, detail: string) => Promise<boolean>
  signal?: AbortSignal
}

export type ToolResult = {
  /** Text handed back to the brain. */
  content: string
  isError?: boolean
  /** Not shown to the brain; used by the UI layer. */
  display?: string
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  /** True when the tool can modify state; drives the permission prompt. */
  readonly mutates: boolean
  run(input: any, ctx: ToolContext): Promise<ToolResult>
}

export function toolDef(t: Tool): ToolDef {
  return { name: t.name, description: t.description, parameters: t.parameters }
}

export function ok(content: string, display?: string): ToolResult {
  return { content, ...(display ? { display } : {}) }
}

export function fail(message: string): ToolResult {
  return { content: message, isError: true }
}
