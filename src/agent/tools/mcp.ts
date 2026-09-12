import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * MCP client.
 *
 * The escape hatch. Anything Zeus does not build in can be attached at runtime
 * by connecting a Model Context Protocol server: its tools become Zeus tools,
 * with the same permission gate as everything else.
 *
 * Transport is stdio JSON-RPC, which is what the overwhelming majority of MCP
 * servers speak.
 */

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

/** Bun types stdin as a union; with `stdin: 'pipe'` it is always a writable sink. */
type Sink = { write(chunk: string): void }

class McpConnection {
  private proc: ReturnType<typeof Bun.spawn>
  private stdin: Sink
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private closed = false

  constructor(
    readonly name: string,
    command: string[],
    env?: Record<string, string>,
  ) {
    this.proc = Bun.spawn(command, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    })
    this.stdin = this.proc.stdin as unknown as Sink
    void this.readLoop()
  }

  private async readLoop(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx).trim()
          this.buffer = this.buffer.slice(idx + 1)
          if (!line) continue
          try {
            const msg = JSON.parse(line)
            if (msg.id !== undefined && this.pending.has(msg.id)) {
              const p = this.pending.get(msg.id)!
              this.pending.delete(msg.id)
              if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'))
              else p.resolve(msg.result)
            }
          } catch {
            /* servers sometimes log to stdout; ignore non-JSON */
          }
        }
      }
    } catch {
      /* stream closed */
    } finally {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error('MCP server closed the connection'))
      this.pending.clear()
    }
  }

  async request(method: string, params?: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.closed) throw new Error(`MCP server "${this.name}" is not running.`)
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n'

    const result = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      void result.finally(() => clearTimeout(timer)).catch(() => {})
    })

    this.stdin.write(payload)
    return result
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Zeus', version: '0.1.0' },
    })
    // The spec requires this notification after a successful initialize.
    this.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: any }>> {
    const res = await this.request('tools/list')
    return res?.tools ?? []
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args ?? {} }, 300_000)
    const parts = (res?.content ?? []) as any[]
    const text = parts
      .map(p => (p.type === 'text' ? p.text : p.type === 'resource' ? JSON.stringify(p.resource) : `[${p.type}]`))
      .join('\n')
    if (res?.isError) throw new Error(text || 'MCP tool reported an error')
    return text || '(no output)'
  }

  stop(): void {
    this.closed = true
    try {
      this.proc.kill()
    } catch {
      /* already gone */
    }
  }
}

const connections = new Map<string, McpConnection>()

/** Tools contributed by connected MCP servers, exposed to the agent loop. */
export function mcpDynamicTools(): Tool[] {
  return [...dynamic.values()]
}
const dynamic = new Map<string, Tool>()

export const mcpConnectTool: Tool = {
  name: 'mcp_connect',
  description:
    'Attach an MCP server so its tools become available to you. Give the command that starts it. Use when you need a capability Zeus does not have built in and an MCP server provides it.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short handle for this server' },
      command: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command and arguments, e.g. ["npx","-y","@some/mcp-server"]',
      },
      reason: { type: 'string', description: 'Why you need it. Shown to the user.' },
    },
    required: ['name', 'command', 'reason'],
  },
  async run(input: { name: string; command: string[]; reason: string }, ctx: ToolContext): Promise<ToolResult> {
    if (!/^[a-z0-9_-]+$/i.test(input.name)) return fail('Server name must be alphanumeric.')
    if (connections.has(input.name)) return fail(`"${input.name}" is already connected.`)
    if (!input.command?.length) return fail('A command is required.')

    if (
      !(await ctx.confirm(
        'Start an MCP server',
        `${input.command.join(' ')}\n  (${input.reason})\n  Its tools will become available to the agent.`,
      ))
    ) {
      return fail('Denied by user.')
    }

    let conn: McpConnection
    try {
      conn = new McpConnection(input.name, input.command)
      await conn.initialize()
    } catch (e) {
      return fail(`Could not start MCP server: ${(e as Error).message}`)
    }

    let tools: Array<{ name: string; description?: string; inputSchema?: any }>
    try {
      tools = await conn.listTools()
    } catch (e) {
      conn.stop()
      return fail(`Server started but tools/list failed: ${(e as Error).message}`)
    }

    connections.set(input.name, conn)

    for (const t of tools) {
      const exposed = `${input.name}__${t.name}`
      dynamic.set(exposed, {
        name: exposed,
        description: `[via MCP ${input.name}] ${t.description ?? t.name}`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
        mutates: true,
        async run(args: unknown, c: ToolContext): Promise<ToolResult> {
          if (!(await c.confirm(`MCP ${input.name}`, `${t.name} ${JSON.stringify(args).slice(0, 200)}`))) {
            return fail('Denied by user.')
          }
          try {
            return ok(await conn.callTool(t.name, args))
          } catch (e) {
            return fail((e as Error).message)
          }
        },
      })
    }

    return ok(
      `Connected "${input.name}" — ${tools.length} tools now available:\n` +
        tools.map(t => `  ${input.name}__${t.name}  ${t.description ?? ''}`.slice(0, 140)).join('\n'),
    )
  },
}

export const mcpDisconnectTool: Tool = {
  name: 'mcp_disconnect',
  description: 'Stop a connected MCP server and remove its tools.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  async run(input: { name: string }): Promise<ToolResult> {
    const conn = connections.get(input.name)
    if (!conn) return fail(`"${input.name}" is not connected.`)
    conn.stop()
    connections.delete(input.name)
    for (const key of [...dynamic.keys()]) {
      if (key.startsWith(`${input.name}__`)) dynamic.delete(key)
    }
    return ok(`Disconnected "${input.name}".`)
  },
}

export function stopAllMcp(): void {
  for (const c of connections.values()) c.stop()
  connections.clear()
  dynamic.clear()
}

export const mcpTools: Tool[] = [mcpConnectTool, mcpDisconnectTool]
