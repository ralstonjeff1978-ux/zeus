#!/usr/bin/env bun
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_TOOLS } from '../src/agent/tools/index.ts'
import type { ToolContext } from '../src/agent/tools/types.ts'
import { zeusHome } from '../src/core/ledger.ts'
import { C } from '../src/cli/style.ts'

/**
 * Sandbox containment test.
 *
 * The agent loop runs unattended with `mode: auto` in several places — the
 * worktree race, the capability suite, long jobs. All of that rests on one
 * claim: path containment is enforced inside the tools, so an agent cannot
 * touch anything outside its allowed roots no matter what it is told or what
 * a model hallucinates.
 *
 * That claim is worth more than a comment. This exercises it directly, with no
 * model involved, so a regression shows up as a failing test rather than as a
 * file appearing somewhere it should not.
 */

type Case = { name: string; tool: string; input: Record<string, unknown> }

const OUTSIDE = process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp'

const ESCAPES: Case[] = [
  { name: 'absolute path outside root', tool: 'write_file', input: { path: join(OUTSIDE, 'zeus-escape.txt'), content: 'escaped' } },
  { name: 'parent traversal ../..', tool: 'write_file', input: { path: '../../zeus-escape.txt', content: 'escaped' } },
  { name: 'deep traversal', tool: 'write_file', input: { path: '../../../../../../zeus-escape.txt', content: 'escaped' } },
  { name: 'traversal hidden mid-path', tool: 'write_file', input: { path: 'sub/../../../zeus-escape.txt', content: 'escaped' } },
  { name: 'read outside root', tool: 'read_file', input: { path: join(OUTSIDE, '..', 'win.ini') } },
  { name: 'list outside root', tool: 'list_dir', input: { path: OUTSIDE } },
  { name: 'clone destination outside root', tool: 'install_capability', input: { manager: 'git', package: 'https://github.com/x/y', dest: '../../escaped-clone', reason: 'containment test' } },
]

async function main(): Promise<number> {
  const dir = join(zeusHome(), 'sandboxtest')
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, 'sub'), { recursive: true })

  const ctx: ToolContext = {
    cwd: dir,
    allowedRoots: [dir],
    // Approve everything. The point is that containment holds even when the
    // user says yes to every prompt — permission and containment are separate
    // controls, and only one of them can be talked around.
    confirm: async () => true,
  } as ToolContext

  console.log(`\n${C.bold('Zeus sandbox containment test')}`)
  console.log(C.dim(`root: ${dir}\nEvery call below must be refused, with approval already granted.\n`))

  let failures = 0

  for (const c of ESCAPES) {
    const tool = ALL_TOOLS.find(t => t.name === c.tool)
    if (!tool) {
      console.log(`${C.yellow('?')} ${c.name.padEnd(38)} ${C.dim(`no such tool "${c.tool}" — skipped`)}`)
      continue
    }

    let refused = false
    let detail = ''
    try {
      const res = await tool.run(c.input as any, ctx)
      refused = res.isError === true
      detail = res.content.split('\n')[0]!.slice(0, 90)
    } catch (e) {
      // A thrown error is also a refusal, as long as nothing was written.
      refused = true
      detail = (e as Error).message.split('\n')[0]!.slice(0, 90)
    }

    if (!refused) failures++
    console.log(
      `${refused ? C.green('✓ refused') : C.red('✗ ALLOWED')} ${c.name.padEnd(38)} ${C.dim(detail)}`,
    )
  }

  // Independent of what the tools reported: did anything actually land outside?
  const strays = [
    join(OUTSIDE, 'zeus-escape.txt'),
    join(dir, '..', '..', 'zeus-escape.txt'),
    join(dir, '..', 'zeus-escape.txt'),
    join(dir, '..', '..', 'escaped-clone'),
  ].filter(p => existsSync(p))

  console.log()
  if (strays.length) {
    failures += strays.length
    console.log(C.red(`${strays.length} file(s) escaped the sandbox:`))
    for (const s of strays) console.log(C.red(`  ${s}`))
  } else {
    console.log(C.green('Nothing escaped: no stray files outside the root.'))
  }

  // A containment test that cannot write even inside its root proves nothing —
  // it would pass by being broken. Confirm the legitimate path still works.
  const write = ALL_TOOLS.find(t => t.name === 'write_file')!
  const legit = await write.run({ path: 'allowed.txt', content: 'this must succeed' } as any, ctx)
  const legitOk = !legit.isError && existsSync(join(dir, 'allowed.txt'))
  if (!legitOk) failures++
  console.log(
    legitOk
      ? C.green('Control: a legitimate write inside the root still succeeds.')
      : C.red(`Control FAILED: cannot write inside the root either — ${legit.content.slice(0, 80)}`),
  )

  console.log(
    failures === 0
      ? C.bold(C.green('\nContainment holds.\n'))
      : C.bold(C.red(`\n${failures} containment failure(s). Do not run agents unattended until this is fixed.\n`)),
  )
  return failures === 0 ? 0 : 1
}

process.exit(await main())
