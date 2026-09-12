import type { Tool } from './tools/types.ts'

/**
 * Permission policy.
 *
 * The policy is per-agent, not global. A weak local brain fanning out on a
 * speculative branch should not have the same reach as the brain the user is
 * sitting in front of, and a swarm worker confined to a worktree should not be
 * able to write outside it.
 */

export type PermissionMode =
  /** Ask before anything that mutates state. */
  | 'ask'
  /** File edits proceed silently; shell commands still ask. */
  | 'auto-edit'
  /** Everything proceeds. Intended for a worktree the agent cannot escape. */
  | 'auto'
  /** Nothing may mutate. Read-only analysis and review. */
  | 'readonly'

export type Policy = {
  mode: PermissionMode
  /** Tool names this agent may use at all. Empty means all. */
  allowTools?: string[]
  /** Tool names denied outright, applied after allowTools. */
  denyTools?: string[]
}

export type Confirmer = (action: string, detail: string) => Promise<boolean>

export function filterTools(tools: Tool[], policy: Policy): Tool[] {
  let out = tools
  if (policy.mode === 'readonly') out = out.filter(t => !t.mutates)
  if (policy.allowTools?.length) {
    const allow = new Set(policy.allowTools)
    out = out.filter(t => allow.has(t.name))
  }
  if (policy.denyTools?.length) {
    const deny = new Set(policy.denyTools)
    out = out.filter(t => !deny.has(t.name))
  }
  return out
}

/**
 * Build the confirm callback a tool receives.
 * @param ask  How to actually put the question to the user.
 */
export function confirmerFor(policy: Policy, ask: Confirmer): Confirmer {
  return async (action, detail) => {
    switch (policy.mode) {
      case 'readonly':
        return false
      case 'auto':
        return true
      case 'auto-edit':
        // Shell commands are the ones that reach outside the workspace.
        return /^Run /.test(action) ? ask(action, detail) : true
      case 'ask':
      default:
        return ask(action, detail)
    }
  }
}

/** Non-interactive contexts need a decision without a human present. */
export function nonInteractiveConfirmer(policy: Policy): Confirmer {
  return async () => policy.mode === 'auto' || policy.mode === 'auto-edit'
}
