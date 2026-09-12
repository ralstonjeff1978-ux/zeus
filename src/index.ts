#!/usr/bin/env bun
import { ZEUS, banner } from './identity.ts'
import { parseArgs, str, bool, num, list } from './cli/args.ts'
import { C } from './cli/style.ts'
import { RegistryError, registryPath } from './registry/registry.ts'

/**
 * Zeus command line.
 *
 * Commands are loaded on demand: starting the CLI should not pay for the
 * database, the job engine and every adapter when the user typed `zeus --help`.
 */

function usage(): string {
  return `${C.bold(banner())}

${C.bold('BRAINS')}
  zeus brains                      List registered brains, grouped local and cloud
  zeus discover [--save]           Find local inference servers and their models
  zeus test <id|--all>             Probe what a brain can actually do
  zeus ask <id> <prompt...>        One prompt, one brain

${C.bold('WORK')}
  zeus do <task...>                Run the agent on a task
      --brain <id>                 Brain to use (default: registry default)
      --role <role>                Pick a brain by role instead
      --mode <ask|auto-edit|auto|readonly>
      --dir <path>                 Working directory (default: cwd)
      --tools <set>                all | code | review | system | research | media
      --max-turns <n>  --budget <usd>  --fallback <id,id>  --yes

${C.bold('SWARM')}   several brains, one task
  zeus swarm <prompt...>           Several brains answer; a different one judges
      --brains <id,id,id>  --judge <id>
  zeus consensus <prompt...>       Several brains answer independently, no judge
  zeus pipe <name> <goal...>       Brains in series, each building on the last
      --list  --brains <id,id>  --show-all  --keep-going
  zeus race <task...>              Brains attempt the same code change in
                                   isolated git worktrees; the diffs compete
      --brains <id,id>  --judge <id>  --dir <path>  --verify "<cmd>"
      --max-turns <n>  --budget <usd>  --tools <set>  --keep  --yes

${C.bold('JOBS')}   long, resumable work
  zeus job start <recipe> <goal...>   Recipes: design, book, research
      --title <t>  --dir <path>  --state <json>
  zeus job run <id>                Run or resume a job
      --steps <n>  --budget <usd>  --brain <id>
  zeus job list                    All jobs and their progress
  zeus job show <id>               Steps and their status
  zeus job improve <id>            Queue another critique/revise pass

${C.bold('SERVE')}
  zeus serve [--port 8787]         Anthropic-shaped endpoint over your registry

${C.bold('SAFETY')}
  zeus checkpoint create [label]   Snapshot files before a risky run
  zeus checkpoint list|diff <id>   See what changed since
  zeus checkpoint restore <id>     Roll back  (--clean also removes new files)

${C.bold('AUDIT')}
  zeus ledger [--remote] [--since <iso>]   What left this machine
  zeus pdf <file.html>             Render an HTML file to PDF
  zeus where                       Show config paths

  Registry: ${registryPath()}
  Override with $ZEUS_BRAINS. Zeus sends no telemetry and makes no update checks.
`
}

async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv)
  const [cmd, ...rest] = p._

  switch (cmd) {
    case 'brains':
    case 'brain': {
      const { cmdBrains } = await import('./cli/brainsCmd.ts')
      return cmdBrains()
    }
    case 'discover': {
      const { cmdDiscover } = await import('./cli/brainsCmd.ts')
      return cmdDiscover(bool(p, 'save'))
    }
    case 'test': {
      const { cmdTest } = await import('./cli/brainsCmd.ts')
      const target = rest[0] ?? (bool(p, 'all') ? '--all' : undefined)
      if (!target) {
        console.error('Usage: zeus test <id|--all>')
        return 2
      }
      return cmdTest(target)
    }
    case 'ask': {
      const { cmdAsk } = await import('./cli/brainsCmd.ts')
      if (rest.length < 1) {
        console.error('Usage: zeus ask <id> <prompt...>')
        return 2
      }
      return cmdAsk(rest[0]!, rest.slice(1).join(' '))
    }

    case 'do': {
      if (!rest.length) {
        console.error('Usage: zeus do <task...>')
        return 2
      }
      const { runAgentCommand } = await import('./cli/agentCmd.ts')
      const mode = (str(p, 'mode') ?? 'ask') as any
      if (!['ask', 'auto-edit', 'auto', 'readonly'].includes(mode)) {
        console.error(`Unknown mode "${mode}". Use ask, auto-edit, auto or readonly.`)
        return 2
      }
      return runAgentCommand(rest.join(' '), {
        brain: str(p, 'brain', 'b'),
        role: str(p, 'role'),
        mode,
        cwd: str(p, 'dir', 'C') ?? process.cwd(),
        toolSet: str(p, 'tools'),
        maxTurns: num(p, 'max-turns'),
        maxCostUsd: num(p, 'budget'),
        fallbacks: list(p, 'fallback'),
        yes: bool(p, 'yes', 'y'),
      })
    }

    case 'swarm':
    case 'consensus': {
      if (!rest.length) {
        console.error(`Usage: zeus ${cmd} <prompt...>`)
        return 2
      }
      const { cmdSwarm } = await import('./cli/swarmCmd.ts')
      return cmdSwarm(rest.join(' '), {
        brains: list(p, 'brains'),
        judge: str(p, 'judge'),
        consensusOnly: cmd === 'consensus',
      })
    }

    case 'pipe':
    case 'pipeline': {
      const { cmdPipeline } = await import('./cli/pipelineCmd.ts')
      const name = bool(p, 'list') ? 'list' : rest[0]
      return cmdPipeline(name, rest.slice(1).join(' '), {
        brains: list(p, 'brains'),
        keepGoing: bool(p, 'keep-going'),
        showAll: bool(p, 'show-all'),
      })
    }

    case 'race': {
      if (!rest.length) {
        console.error('Usage: zeus race <task...>')
        return 2
      }
      const { cmdRace } = await import('./cli/worktreeCmd.ts')
      return cmdRace(rest.join(' '), {
        brains: list(p, 'brains'),
        judge: str(p, 'judge'),
        dir: str(p, 'dir', 'C'),
        verify: str(p, 'verify'),
        maxTurns: num(p, 'max-turns'),
        budget: num(p, 'budget'),
        tools: str(p, 'tools'),
        keep: bool(p, 'keep'),
        yes: bool(p, 'yes', 'y'),
      })
    }

    case 'job': {
      const { cmdJob } = await import('./cli/jobCmd.ts')
      return cmdJob(rest, p)
    }

    case 'serve': {
      const { cmdServe } = await import('./cli/serveCmd.ts')
      return cmdServe({
        port: num(p, 'port') ?? 8787,
        host: str(p, 'host'),
        fallbacks: list(p, 'fallback'),
      })
    }

    case 'checkpoint':
    case 'ck': {
      const { cmdCheckpoint } = await import('./cli/checkpointCmd.ts')
      return cmdCheckpoint(rest, p)
    }

    case 'ledger': {
      const { cmdLedger } = await import('./cli/ledgerCmd.ts')
      return cmdLedger({ remote: bool(p, 'remote'), since: str(p, 'since') })
    }

    case 'pdf': {
      if (!rest[0]) {
        console.error('Usage: zeus pdf <file.html>')
        return 2
      }
      const { cmdPdf } = await import('./cli/ledgerCmd.ts')
      return cmdPdf(rest[0]!)
    }

    case 'where': {
      const { zeusHome, ledgerPath } = await import('./core/ledger.ts')
      console.log(`registry  ${registryPath()}`)
      console.log(`home      ${zeusHome()}`)
      console.log(`ledger    ${ledgerPath()}`)
      return 0
    }

    case '--version':
    case '-v':
      console.log(`${ZEUS.name} ${ZEUS.version}`)
      return 0

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(usage())
      return 0

    default:
      console.error(`Unknown command "${cmd}".\n${usage()}`)
      return 2
  }
}

try {
  const code = await main(process.argv.slice(2))
  const { stopAllMcp } = await import('./agent/tools/mcp.ts')
  stopAllMcp()
  process.exit(code)
} catch (e) {
  if (e instanceof RegistryError) {
    console.error(C.red(e.message))
    process.exit(1)
  }
  console.error(C.red((e as Error).message))
  if (process.env.ZEUS_DEBUG) console.error((e as Error).stack)
  process.exit(1)
}
