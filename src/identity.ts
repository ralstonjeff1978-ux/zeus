/**
 * Zeus knows itself as Zeus. Nothing in this project derives its identity,
 * naming, or behaviour from any other tool.
 */

export const ZEUS = {
  name: 'Zeus',
  version: '0.1.0',
  tagline: 'Universal, local-first AI coding tool and assistant.',
} as const

/** Zeus never phones home. This constant exists to be asserted against in tests. */
export const TELEMETRY_ENDPOINTS: readonly string[] = []

export function banner(): string {
  return `${ZEUS.name} ${ZEUS.version} — ${ZEUS.tagline}`
}
