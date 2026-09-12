import { resolve } from 'node:path'
import { createCheckpoint, listCheckpoints, diffCheckpoint, restoreCheckpoint, deleteCheckpoint } from '../agent/checkpoint.ts'
import { C } from './style.ts'
import { bool, str, type Parsed } from './args.ts'

/** Checkpoint commands: snapshot, inspect and roll back agent edits. */

export async function cmdCheckpoint(rest: string[], p: Parsed): Promise<number> {
  const sub = rest[0]

  switch (sub) {
    case 'create': {
      const dir = str(p, 'dir') ?? process.cwd()
      const label = rest.slice(1).join(' ') || 'manual'
      const res = await createCheckpoint(dir, label)
      console.log(`${C.green('Checkpoint')} ${C.bold(res.id)} — ${res.files} files from ${resolve(dir)}`)
      return 0
    }

    case 'list': {
      const rows = listCheckpoints()
      if (!rows.length) {
        console.log('No checkpoints.')
        return 0
      }
      for (const c of rows) {
        console.log(
          `${c.id.padEnd(22)} ${C.dim(c.createdAt.slice(0, 16).replace('T', ' '))} ${String(c.files).padStart(5)} files  ${c.label.slice(0, 40)}`,
        )
        console.log(C.dim(`  ${c.root}`))
      }
      return 0
    }

    case 'diff': {
      const id = rest[1]
      if (!id) {
        console.error('Usage: zeus checkpoint diff <id>')
        return 2
      }
      const d = await diffCheckpoint(id)
      if (!d.changed.length && !d.added.length && !d.deleted.length) {
        console.log(C.green('Nothing has changed since this checkpoint.'))
        return 0
      }
      for (const f of d.changed) console.log(`${C.yellow('M')} ${f}`)
      for (const f of d.added) console.log(`${C.green('A')} ${f}`)
      for (const f of d.deleted) console.log(`${C.red('D')} ${f}`)
      console.log(
        C.dim(`\n${d.changed.length} modified, ${d.added.length} added, ${d.deleted.length} deleted`),
      )
      return 0
    }

    case 'restore': {
      const id = rest[1]
      if (!id) {
        console.error('Usage: zeus checkpoint restore <id> [--clean]')
        return 2
      }
      const d = await diffCheckpoint(id)
      console.log(
        `This will restore ${d.changed.length} modified and ${d.deleted.length} deleted file(s)` +
          (bool(p, 'clean') ? `, and delete ${d.added.length} file(s) created since.` : '.'),
      )
      if (!bool(p, 'clean') && d.added.length) {
        console.log(C.dim(`${d.added.length} file(s) created since will be left alone. Pass --clean to remove them.`))
      }
      const res = await restoreCheckpoint(id, bool(p, 'clean'))
      console.log(`${C.green('Restored')} ${res.restored} file(s)${res.removed ? `, removed ${res.removed}` : ''}.`)
      return 0
    }

    case 'delete': {
      const id = rest[1]
      if (!id) {
        console.error('Usage: zeus checkpoint delete <id>')
        return 2
      }
      deleteCheckpoint(id)
      console.log(`Deleted ${id}.`)
      return 0
    }

    default:
      console.error('Usage: zeus checkpoint <create|list|diff|restore|delete>')
      return 2
  }
}
