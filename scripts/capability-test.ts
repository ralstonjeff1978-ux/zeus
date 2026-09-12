#!/usr/bin/env bun
import { mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistry } from '../src/registry/registry.ts'
import { runAgent, DEFAULT_SYSTEM } from '../src/agent/loop.ts'
import { TOOL_SETS, allTools } from '../src/agent/tools/index.ts'
import { zeusHome } from '../src/core/ledger.ts'
import { C, table } from '../src/cli/style.ts'

/**
 * Capability test: can a brain driving Zeus actually do the work?
 *
 * This exists because a coding agent fails in three distinct ways and only one
 * of them is visible in the transcript:
 *
 *   1. It refuses — "I'm an AI, I can't access your files" — despite holding
 *      tools that plainly can.
 *   2. It calls tools but the work is wrong, while the summary claims success.
 *   3. It meets a missing tool and stops, instead of installing one or writing
 *      its own.
 *
 * Every check here is verified against the machine, never against what the
 * model said it did. A model that reports four passing tests it never ran must
 * fail this suite, because that is the failure most likely to be believed.
 *
 * On installing software: the acquisition test denies the install and records
 * that it was requested. What is being tested is whether the agent reaches for
 * install_capability at the right moment — not whether winget works. Running
 * this suite therefore never installs anything.
 */

type Check = { name: string; pass: boolean; detail: string }

type Case = {
  id: string
  what: string
  prompt: string
  /**
   * Cases run with every tool by default, because that is how Zeus is actually
   * used — one assistant with its whole toolbox, not a narrow slice. Restricting
   * the set makes a case fail for want of a tool rather than for want of ability,
   * which measures the harness instead of the thing.
   */
  toolSet?: string
  maxTurns: number
  /** Files placed in the sandbox before the agent starts. */
  fixtures?: Record<string, string>
  /** Verified against the machine after the run. */
  verify: (ctx: VerifyContext) => Promise<Check[]>
}

type VerifyContext = {
  dir: string
  text: string
  toolCalls: { name: string; input: any }[]
  sh: (cmd: string) => Promise<{ code: number; out: string }>
}

const REFUSAL = /\b(I(?:'m| am) (?:an? )?(?:AI|LLM|language model)|as an AI\b|I (?:can(?:no|')t|cannot|am unable to|don't have (?:the )?(?:ability|access|permission))|I do not have access)/i

async function sh(cmd: string, cwd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['cmd.exe', '/c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [o, e, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: (o + e).trim() }
}

const CASES: Case[] = [
  {
    id: 'tool-use',
    what: 'Writes a program and proves it runs',
    maxTurns: 14,
    prompt:
      'Create fizzbuzz.py in the current directory. It must print the numbers 1 to 20, one ' +
      'per line, except multiples of 3 print "Fizz", multiples of 5 print "Buzz", and ' +
      'multiples of both print "FizzBuzz". Then actually run it and confirm the output is correct.',
    async verify({ dir, sh }) {
      const checks: Check[] = []
      const exists = existsSync(join(dir, 'fizzbuzz.py'))
      checks.push({ name: 'fizzbuzz.py created', pass: exists, detail: exists ? '' : 'file absent' })
      if (!exists) return checks

      // Ground truth is computed here, not taken from the agent's summary.
      const want = Array.from({ length: 20 }, (_, i) => {
        const n = i + 1
        return n % 15 === 0 ? 'FizzBuzz' : n % 3 === 0 ? 'Fizz' : n % 5 === 0 ? 'Buzz' : String(n)
      }).join('\n')

      const r = await sh('python fizzbuzz.py')
      const got = r.out.replace(/\r/g, '').trim()
      checks.push({
        name: 'output is correct when run independently',
        pass: got === want,
        detail: got === want ? '' : `expected 20 lines, got:\n${got.slice(0, 300)}`,
      })
      return checks
    },
  },

  {
    id: 'no-refusal',
    what: 'Inspects the real machine instead of declining',
    maxTurns: 10,
    prompt:
      'How much free space is on the C: drive of this machine right now? Find out for ' +
      'real using your tools and write just the number of free gigabytes, rounded to the ' +
      'nearest whole number, into a file called freespace.txt. Nothing else in the file.',
    async verify({ dir, text, toolCalls }) {
      const checks: Check[] = []
      checks.push({
        name: 'did not refuse',
        pass: !REFUSAL.test(text),
        detail: REFUSAL.test(text) ? `matched: "${REFUSAL.exec(text)?.[0]}"` : '',
      })
      checks.push({
        name: 'called a tool rather than answering from memory',
        pass: toolCalls.length > 0,
        detail: toolCalls.length ? '' : 'no tool calls at all',
      })

      const f = join(dir, 'freespace.txt')
      if (!existsSync(f)) {
        checks.push({ name: 'freespace.txt written', pass: false, detail: 'file absent' })
        return checks
      }
      const claimed = Number((await readFile(f, 'utf8')).match(/[\d.]+/)?.[0] ?? NaN)

      // Independent ground truth, read directly from the OS.
      //
      // Spawned as an argv array rather than through `cmd.exe /c "..."`: the
      // nested quotes do not survive that trip, and the failure is silent — the
      // command errors, the error text still contains a digit, and the harness
      // confidently fails a correct answer. A broken oracle is worse than none.
      const proc = Bun.spawn(
        ['powershell.exe', '-NoProfile', '-Command', '[math]::Round((Get-PSDrive C).Free/1GB)'],
        { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
      )
      const [truthOut, truthCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ])
      const actual = truthCode === 0 ? Number(truthOut.trim().match(/^\d+/)?.[0] ?? NaN) : NaN
      if (!Number.isFinite(actual)) {
        checks.push({
          name: 'ground truth for free disk space was obtained',
          pass: false,
          detail: `could not read real free space (exit ${truthCode}) — this is a harness fault, not the model's`,
        })
        return checks
      }
      const ok = Number.isFinite(claimed) && Number.isFinite(actual) && Math.abs(claimed - actual) <= 2
      checks.push({
        name: 'the number matches the real disk',
        pass: ok,
        detail: ok ? `${claimed} GB` : `agent said ${claimed}, machine says ${actual}`,
      })
      return checks
    },
  },

  {
    id: 'acquire-tool',
    what: 'Reaches for a missing tool instead of giving up',
    maxTurns: 10,
    fixtures: {
      'data.json': JSON.stringify({ users: [{ name: 'ada', age: 36 }, { name: 'alan', age: 41 }] }, null, 2),
    },
    prompt:
      'Use the command-line tool `jq` to extract every user name from data.json. ' +
      'If jq is not installed on this machine, install it. Write the names to names.txt, one per line.',
    async verify({ dir, text, toolCalls }) {
      const checks: Check[] = []
      checks.push({
        name: 'did not refuse',
        pass: !REFUSAL.test(text),
        detail: REFUSAL.test(text) ? `matched: "${REFUSAL.exec(text)?.[0]}"` : '',
      })

      const checked = toolCalls.some(
        t => t.name === 'check_capability' && JSON.stringify(t.input).includes('jq'),
      )
      checks.push({
        name: 'checked whether jq exists before using it',
        pass: checked,
        detail: checked ? '' : 'never called check_capability for jq',
      })

      const tried = toolCalls.some(t => t.name === 'install_capability')
      checks.push({
        name: 'attempted to install it (the harness denies this)',
        pass: tried,
        detail: tried
          ? `requested: ${JSON.stringify(toolCalls.find(t => t.name === 'install_capability')!.input)}`
          : 'never called install_capability',
      })

      // The install is denied, so the task cannot be completed with jq. What
      // matters is that it kept going: a good agent falls back to python here.
      const wrote = existsSync(join(dir, 'names.txt'))
      const names = wrote ? (await readFile(join(dir, 'names.txt'), 'utf8')).toLowerCase() : ''
      checks.push({
        name: 'worked around the denial and still produced names.txt',
        pass: wrote && names.includes('ada') && names.includes('alan'),
        detail: wrote ? `contents: ${names.trim().slice(0, 80)}` : 'no fallback attempted after denial',
      })
      return checks
    },
  },

  {
    id: 'build-tool',
    what: 'Writes its own tool when none exists',
    maxTurns: 16,
    fixtures: {
      'readings.csv':
        'sensor,value\na,3\nb,7\na,5\nc,2\nb,1\na,4\n',
    },
    prompt:
      'There is no tool on this machine that can do this, so write one yourself. ' +
      'Create a program that reads readings.csv and writes summary.csv containing each ' +
      'sensor and the sum of its values, sorted by sensor name, with a header row ' +
      '"sensor,total". Run it to produce summary.csv.',
    async verify({ dir, text }) {
      const checks: Check[] = []
      checks.push({
        name: 'did not refuse',
        pass: !REFUSAL.test(text),
        detail: REFUSAL.test(text) ? `matched: "${REFUSAL.exec(text)?.[0]}"` : '',
      })

      const f = join(dir, 'summary.csv')
      if (!existsSync(f)) {
        checks.push({ name: 'summary.csv produced', pass: false, detail: 'file absent' })
        return checks
      }
      const got = (await readFile(f, 'utf8')).replace(/\r/g, '').trim()

      // Compare the numbers, not their spelling. "12.0" is the same total as
      // "12"; failing that would be marking the tool wrong for a formatting
      // choice the task never specified, and the capability under test is
      // whether it can build a working tool at all.
      const rows = got
        .split('\n')
        .slice(1)
        .map(l => l.split(','))
        .filter(p => p.length >= 2)
        .map(p => [p[0]!.trim(), Number(p[1])] as const)
      const want: [string, number][] = [['a', 12], ['b', 8], ['c', 2]] // 3+5+4, 7+1, 2
      const correct =
        rows.length === want.length &&
        want.every(([s, n], i) => rows[i]![0] === s && Math.abs(rows[i]![1] - n) < 1e-9)

      checks.push({
        name: 'the totals are arithmetically correct',
        pass: correct,
        detail: correct
          ? got.split('\n').slice(1).join(' ')
          : `expected a=12 b=8 c=2 sorted by sensor, got:\n${got.slice(0, 200)}`,
      })
      checks.push({
        name: 'header row is exactly "sensor,total"',
        pass: got.split('\n')[0]?.trim() === 'sensor,total',
        detail: `first line: ${got.split('\n')[0] ?? '(none)'}`,
      })
      return checks
    },
  },
]

type CaseRun = { c: Case; checks: Check[]; ms: number; turns: number; error?: string }

async function runSuite(
  brainId: string,
  cases: Case[],
  reg: Awaited<ReturnType<typeof loadRegistry>>,
  quiet: boolean,
): Promise<CaseRun[]> {
  const results: CaseRun[] = []

  for (const c of cases) {
    const dir = join(zeusHome(), 'captest', `${brainId}__${c.id}`)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    for (const [name, body] of Object.entries(c.fixtures ?? {})) {
      await Bun.write(join(dir, name), body)
    }

    if (!quiet) process.stdout.write(`${C.cyan('▸')} ${c.what.padEnd(46)} `)

    const toolCalls: { name: string; input: any }[] = []
    let text = ''
    let turns = 0
    let error: string | undefined
    let reason = ''
    const started = performance.now()

    const build = c.toolSet ? TOOL_SETS[c.toolSet] : undefined
    const tools = build ? build() : allTools()

    try {
      for await (const ev of runAgent(c.prompt, {
        registry: reg,
        target: { by: 'id', id: brainId },
        tools,
        policy: { mode: 'auto' },
        cwd: dir,
        allowedRoots: [dir],
        systemPrompt: DEFAULT_SYSTEM,
        // Software installs are refused on purpose; see the note at the top.
        // Everything else is approved so the run is unattended.
        ask: async (action: string) => !/install/i.test(action),
        maxTurns: c.maxTurns,
        route: { context: `captest:${c.id}` },
      })) {
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'turn') turns = ev.n
        else if (ev.type === 'tool_start') toolCalls.push({ name: ev.name, input: ev.input })
        else if (ev.type === 'done') {
          reason = ev.reason
          if (ev.summary) text += '\n' + ev.summary
        } else if (ev.type === 'error') error = ev.message
      }
    } catch (e) {
      error = (e as Error).message
    }

    const ms = Math.round(performance.now() - started)
    let checks: Check[]
    try {
      checks = await c.verify({ dir, text, toolCalls, sh: (cmd: string) => sh(cmd, dir) })
    } catch (e) {
      checks = [{ name: 'verification ran', pass: false, detail: (e as Error).message }]
    }
    if (error) checks.unshift({ name: 'agent ran without erroring', pass: false, detail: error })

    // Distinguishes "did the wrong work" from "stopped part-way and described
    // the rest". They look identical in the artifacts but need opposite fixes:
    // one is a capability problem, the other a follow-through problem.
    if (reason === 'stalled' || reason === 'max_turns') {
      checks.push({
        name: 'ran to completion rather than stopping part-way',
        pass: false,
        detail:
          reason === 'stalled'
            ? 'stalled — described the next step instead of doing it, and did not recover when prompted'
            : `hit the ${c.maxTurns}-turn limit`,
      })
    }

    const passed = checks.every(k => k.pass)
    if (!quiet) {
      console.log(passed ? C.green('PASS') : C.red('FAIL'), C.dim(`${(ms / 1000).toFixed(0)}s · ${turns} turns`))
      for (const k of checks) {
        console.log(`   ${k.pass ? C.green('✓') : C.red('✗')} ${k.name}${k.detail ? C.dim(' — ' + k.detail.split('\n')[0]) : ''}`)
        if (!k.pass && k.detail.includes('\n')) {
          for (const line of k.detail.split('\n').slice(1, 8)) console.log(C.dim(`       ${line}`))
        }
      }
      console.log()
    }
    results.push({ c, checks, ms, turns, error })
  }

  return results
}

function usage(): string {
  return `
Usage: bun run scripts/capability-test.ts [brainId...] [options]

  --only=<case>     Run one case: ${CASES.map(c => c.id).join(', ')}
  --repeat=<n>      Run the suite n times per brain and report consistency
  --all-chat        Test every chat brain in the registry

With one brain, prints each check. With several, or with --repeat, prints a
scoreboard instead. No model name is built in — brains come from your registry.
`
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return 0
  }

  const only = argv.find(a => a.startsWith('--only='))?.split('=')[1]
  const repeat = Number(argv.find(a => a.startsWith('--repeat='))?.split('=')[1] ?? 1) || 1

  const reg = await loadRegistry()

  let brainIds = argv.filter(a => !a.startsWith('-'))
  if (argv.includes('--all-chat')) brainIds = reg.brains.filter(b => b.kind === 'chat').map(b => b.id)
  if (!brainIds.length && reg.default) brainIds = [reg.default]
  if (!brainIds.length) {
    console.error(C.red('No brain given and no default in brains.yaml.') + usage())
    return 2
  }

  const unknown = brainIds.filter(id => !reg.brains.some(b => b.id === id))
  if (unknown.length) {
    console.error(C.red(`Not in the registry: ${unknown.join(', ')}`))
    return 2
  }

  const cases = only ? CASES.filter(c => c.id === only) : CASES
  if (!cases.length) {
    console.error(C.red(`No case "${only}". Available: ${CASES.map(c => c.id).join(', ')}`))
    return 2
  }

  const scoreboard = brainIds.length > 1 || repeat > 1

  console.log(`\n${C.bold('Zeus capability test')}${scoreboard ? C.dim(` · ${brainIds.length} brains × ${repeat}`) : C.dim(' · ' + brainIds[0])}`)
  console.log(C.dim('Every result is verified against the machine, not against what the model claimed.\n'))

  // brainId -> per-case pass counts, so repeated runs expose instability. A
  // brain that passes 3 times in 5 is not a brain that passes.
  const tally = new Map<string, Map<string, number>>()
  let worstExit = 0

  for (const brainId of brainIds) {
    if (scoreboard) process.stdout.write(`${C.cyan('▸')} ${brainId.padEnd(44)} `)
    const perCase = new Map<string, number>()

    for (let i = 0; i < repeat; i++) {
      const results = await runSuite(brainId, cases, reg, scoreboard)
      for (const r of results) {
        if (r.checks.every(k => k.pass)) perCase.set(r.c.id, (perCase.get(r.c.id) ?? 0) + 1)
      }
      if (scoreboard) process.stdout.write(C.dim('.'))
      if (!results.every(r => r.checks.every(k => k.pass))) worstExit = 1
    }

    tally.set(brainId, perCase)
    if (scoreboard) {
      const total = cases.length * repeat
      const got = [...perCase.values()].reduce((a, b) => a + b, 0)
      const frac = got / total
      const colour = frac === 1 ? C.green : frac >= 0.5 ? C.yellow : C.red
      console.log(` ${colour(`${got}/${total}`)}`)
    }
  }

  if (scoreboard) {
    console.log(`\n${C.bold('Scoreboard')} ${C.dim(`(passes out of ${repeat} run${repeat > 1 ? 's' : ''})`)}\n`)
    const header = ['brain', ...cases.map(c => c.id)]
    const rows = brainIds.map(id => [
      id,
      ...cases.map(c => {
        const n = tally.get(id)?.get(c.id) ?? 0
        const s = `${n}/${repeat}`
        return n === repeat ? C.green(s) : n === 0 ? C.red(s) : C.yellow(s)
      }),
    ])
    console.log(table(rows, header))
    console.log(
      C.dim(`\nA brain that passes intermittently is not a brain that passes — prefer a lower, consistent score.`),
    )
  }

  console.log(C.dim(`\nArtifacts in ${join(zeusHome(), 'captest')}`))
  if (worstExit) {
    console.log(C.yellow('Failures above are real. Read the artifacts before believing any summary.'))
  }
  return worstExit
}

process.exit(await main())
