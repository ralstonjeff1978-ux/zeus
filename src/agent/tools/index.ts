import { type Tool, type ToolContext, type ToolResult, ok, fail, toolDef } from './types.ts'
import { fileTools } from './files.ts'
import { shellTools } from './shell.ts'
import { artifactTools } from './artifacts.ts'
import { capabilityTools } from './capability.ts'
import { devTools } from './dev.ts'
import { systemTools } from './system.ts'
import { mediaTools } from './media.ts'
import { dataTools } from './data.ts'
import { memoryTools } from './memory.ts'
import { mcpTools, mcpDynamicTools } from './mcp.ts'
import { delegateTools } from './delegate.ts'

/**
 * The tool registry.
 *
 * Brains generate content; tools produce effects. Everything Zeus can *do*
 * rather than *say* is reachable from here.
 */

/** A scratchpad the brain owns, so multi-step work survives its own forgetting. */
const notes = new Map<string, string>()

export const noteTool: Tool = {
  name: 'note',
  description:
    'Store or recall a short working note by key. Use it to keep a plan, a running list, or a fact you will need many steps later. Omit "value" to read it back. For anything worth keeping past this session, use memory_write instead.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string', description: 'Omit to read the note back' },
    },
    required: ['key'],
  },
  async run(input: { key: string; value?: string }): Promise<ToolResult> {
    if (input.value === undefined) {
      const v = notes.get(input.key)
      return v ? ok(v) : fail(`No note under "${input.key}". Known keys: ${[...notes.keys()].join(', ') || 'none'}`)
    }
    notes.set(input.key, input.value)
    return ok(`Noted "${input.key}".`)
  },
}

export const finishTool: Tool = {
  name: 'finish',
  description:
    'Declare the task complete and stop. Give a short summary of what was done, what you verified, and anything the user must know — including what you could not confirm.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  async run(input: { summary: string }): Promise<ToolResult> {
    return ok(input.summary)
  },
}

/** Static tools. MCP-contributed tools are added at call time by `allTools()`. */
export const ALL_TOOLS: Tool[] = [
  ...fileTools,
  ...devTools,
  ...shellTools,
  ...capabilityTools,
  ...systemTools,
  ...dataTools,
  ...artifactTools,
  ...mediaTools,
  ...memoryTools,
  ...mcpTools,
  ...delegateTools,
  noteTool,
  finishTool,
]

/** Everything currently available, including tools attached at runtime via MCP. */
export function allTools(): Tool[] {
  return [...ALL_TOOLS, ...mcpDynamicTools()]
}

export function toolsByName(names?: string[]): Tool[] {
  if (!names?.length) return allTools()
  const set = new Set(names)
  return allTools().filter(t => set.has(t.name))
}

export function readOnlyTools(): Tool[] {
  return allTools().filter(t => !t.mutates)
}

/**
 * Named bundles, so an agent can be given a sensible subset for its job.
 *
 * Every set that can run commands also gets `capabilityTools`. The system
 * prompt tells the agent to call check_capability and install_capability when a
 * tool it needs is missing; a set that withholds them leaves the agent
 * instructed to call something absent from its own schema, which it resolves by
 * announcing it cannot do the task. An agent that can run `ffmpeg` must be able
 * to go and get `ffmpeg`.
 */
export const TOOL_SETS: Record<string, () => Tool[]> = {
  all: () => allTools(),
  code: () => [...fileTools, ...devTools, ...shellTools, ...capabilityTools, noteTool, finishTool],
  review: () => [
    ...fileTools.filter(t => !t.mutates),
    ...devTools.filter(t => !t.mutates),
    ...capabilityTools.filter(t => !t.mutates),
    noteTool,
    finishTool,
  ],
  system: () => [
    ...systemTools,
    ...shellTools,
    ...fileTools.filter(t => !t.mutates),
    ...capabilityTools,
    noteTool,
    finishTool,
  ],
  research: () => [...capabilityTools, ...dataTools, ...memoryTools, ...fileTools, noteTool, finishTool],
  media: () => [...mediaTools, ...artifactTools, ...fileTools, ...shellTools, ...capabilityTools, noteTool, finishTool],
}

export function clearNotes(): void {
  notes.clear()
}

export { type Tool, type ToolContext, type ToolResult, toolDef, ok, fail }
