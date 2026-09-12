import { type Tool, type ToolContext, type ToolResult, ok, fail } from './types.ts'

/**
 * System inspection, diagnostics and repair.
 *
 * These are the tools that make Zeus useful for fixing a machine rather than
 * only writing code. Every one of them is read-only except `service_control`,
 * which asks. Reading system state is not dangerous; changing it is, and the
 * split is enforced here rather than left to the brain's judgement.
 */

async function ps(script: string, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const p = Bun.spawn(['pwsh', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: ctl.signal,
    })
    const [o, e, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { code, out: [o, e].filter(Boolean).join('\n').trim() }
  } catch (err) {
    return { code: -1, out: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

async function sh(argv: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', signal: ctl.signal })
    const [o, e, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { code, out: [o, e].filter(Boolean).join('\n').trim() }
  } catch (err) {
    return { code: -1, out: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

const isWindows = process.platform === 'win32'

/**
 * WMI reports AdapterRAM as a signed 32-bit value, so any GPU with 4GB or more
 * is misreported. Read the driver's own record from the registry instead.
 */
const GPU_QUERY = `
$gpus = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Virtual|Basic Display|Remote' }
foreach ($g in $gpus) {
  $vram = $null
  try {
    $key = Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction Stop |
           Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DriverDesc -eq $g.Name } | Select-Object -First 1
    if ($key) {
      $qm = (Get-ItemProperty $key.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
      if ($qm) { $vram = [math]::Round($qm / 1GB, 1) }
    }
  } catch {}
  if (-not $vram -and $g.AdapterRAM) { $vram = [math]::Round($g.AdapterRAM / 1GB, 1) }
  "GPU        : $($g.Name)"
  "  VRAM     : $(if ($vram) { "$vram GB" } else { 'unknown' })"
  "  Driver   : $($g.DriverVersion)"
}`

export const systemInfoTool: Tool = {
  name: 'system_info',
  description:
    'Report this machine: CPU, RAM, GPU and VRAM, OS, disks and free space. Read-only. Use before recommending anything that depends on the hardware.',
  mutates: false,
  parameters: { type: 'object', properties: {} },
  async run(): Promise<ToolResult> {
    if (!isWindows) {
      const [cpu, mem, disk] = await Promise.all([
        sh(['bash', '-lc', 'lscpu | head -20']),
        sh(['bash', '-lc', 'free -h']),
        sh(['bash', '-lc', 'df -h']),
      ])
      return ok([cpu.out, mem.out, disk.out].join('\n\n'))
    }

    const res = await ps(`
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor
"OS         : $($os.Caption) $($os.Version)"
"Uptime     : $([math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1)) hours"
"CPU        : $($cpu.Name.Trim())"
"  Cores    : $($cpu.NumberOfCores) physical / $($cpu.NumberOfLogicalProcessors) logical"
"RAM        : $([math]::Round($cs.TotalPhysicalMemory/1GB,1)) GB total, $([math]::Round($os.FreePhysicalMemory/1MB,1)) GB free"
$sticks = Get-CimInstance Win32_PhysicalMemory
foreach ($s in $sticks) { "  Module   : $([math]::Round($s.Capacity/1GB,0))GB @ $($s.ConfiguredClockSpeed)MHz $($s.Manufacturer)" }
${GPU_QUERY}
""
"DISKS"
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  "  $($_.DeviceID) $([math]::Round($_.Size/1GB,1))GB total, $([math]::Round($_.FreeSpace/1GB,1))GB free"
}`)
    return res.code === 0 ? ok(res.out) : fail(res.out)
  },
}

export const diskHealthTool: Tool = {
  name: 'disk_health',
  description:
    'Report physical disk health, SMART status, and per-volume free space. Read-only. Use when diagnosing slowness, corruption or failures.',
  mutates: false,
  parameters: { type: 'object', properties: {} },
  async run(): Promise<ToolResult> {
    if (!isWindows) {
      const r = await sh(['bash', '-lc', 'lsblk -o NAME,SIZE,TYPE,MOUNTPOINT; echo; df -h'])
      return ok(r.out)
    }
    const res = await ps(`
"PHYSICAL DISKS"
Get-PhysicalDisk | ForEach-Object {
  "  $($_.FriendlyName)"
  "    Media      : $($_.MediaType)  Bus: $($_.BusType)"
  "    Size       : $([math]::Round($_.Size/1GB,1)) GB"
  "    Health     : $($_.HealthStatus)   Operational: $($_.OperationalStatus)"
}
""
"RELIABILITY COUNTERS"
try {
  Get-PhysicalDisk | Get-StorageReliabilityCounter -ErrorAction Stop | ForEach-Object {
    "  DeviceId $($_.DeviceId): Temp $($_.Temperature)C  PowerOnHours $($_.PowerOnHours)  ReadErrors $($_.ReadErrorsTotal)  Wear $($_.Wear)"
  }
} catch { "  (reliability counters unavailable — may need an elevated session)" }
""
"VOLUMES"
Get-Volume | Where-Object DriveLetter | ForEach-Object {
  "  $($_.DriveLetter): $($_.FileSystemLabel) [$($_.FileSystem)] $([math]::Round($_.SizeRemaining/1GB,1))GB free of $([math]::Round($_.Size/1GB,1))GB — $($_.HealthStatus)"
}`)
    return res.code === 0 ? ok(res.out) : fail(res.out)
  },
}

export const networkDiagnoseTool: Tool = {
  name: 'network_diagnose',
  description:
    'Diagnose networking: adapters, IP configuration, DNS, routing, listening ports, and optionally connectivity to a host. Read-only.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Optional host to test reachability and DNS against' },
      ports: { type: 'boolean', description: 'Include listening ports and their owning processes' },
    },
  },
  async run(input: { target?: string; ports?: boolean }): Promise<ToolResult> {
    if (!isWindows) {
      const cmds = ['ip -br addr', 'ip route', 'cat /etc/resolv.conf']
      if (input.ports) cmds.push('ss -tulpn')
      if (input.target) cmds.push(`getent hosts ${input.target}; ping -c 3 ${input.target}`)
      const r = await sh(['bash', '-lc', cmds.join(' ; echo ; ')], 90_000)
      return ok(r.out)
    }

    const target = input.target && /^[A-Za-z0-9._-]+$/.test(input.target) ? input.target : undefined
    const script = `
"ADAPTERS"
Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {
  "  $($_.Name) [$($_.InterfaceDescription)] $($_.LinkSpeed)"
}
""
"IP CONFIGURATION"
Get-NetIPConfiguration | ForEach-Object {
  "  $($_.InterfaceAlias): $($_.IPv4Address.IPAddress)  GW $($_.IPv4DefaultGateway.NextHop)  DNS $($_.DNSServer.ServerAddresses -join ', ')"
}
""
"ROUTES (default)"
Get-NetRoute -DestinationPrefix '0.0.0.0/0' | ForEach-Object { "  via $($_.NextHop) on $($_.InterfaceAlias) metric $($_.RouteMetric)" }
${
  input.ports
    ? `
""
"LISTENING PORTS"
Get-NetTCPConnection -State Listen | Sort-Object LocalPort -Unique | ForEach-Object {
  $p = try { (Get-Process -Id $_.OwningProcess -ErrorAction Stop).ProcessName } catch { '?' }
  "  $($_.LocalAddress):$($_.LocalPort)  $p ($($_.OwningProcess))"
}`
    : ''
}
${
  target
    ? `
""
"CONNECTIVITY TO ${target}"
try { (Resolve-DnsName ${target} -ErrorAction Stop | Select-Object -First 3 | ForEach-Object { "  DNS: $($_.Name) -> $($_.IPAddress)$($_.NameHost)" }) } catch { "  DNS lookup failed: $_" }
$t = Test-NetConnection ${target} -WarningAction SilentlyContinue
"  Ping: $($t.PingSucceeded)  RTT: $($t.PingReplyDetails.RoundtripTime)ms"`
    : ''
}`
    const res = await ps(script, 120_000)
    return res.code === 0 ? ok(res.out) : fail(res.out)
  },
}

export const eventLogTool: Tool = {
  name: 'event_log',
  description:
    'Read recent Windows event log entries — errors and warnings by default. Read-only. The first place to look when something crashed or a device failed.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      log: { type: 'string', enum: ['System', 'Application', 'Security'], description: 'Defaults to System' },
      level: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Defaults to error' },
      hours: { type: 'integer', description: 'How far back to look. Defaults to 24.' },
      count: { type: 'integer', description: 'Max entries. Defaults to 40.' },
    },
  },
  async run(input: { log?: string; level?: string; hours?: number; count?: number }): Promise<ToolResult> {
    if (!isWindows) {
      const r = await sh(['bash', '-lc', `journalctl -p err -n ${input.count ?? 40} --no-pager`], 60_000)
      return ok(r.out || '(no journal available)')
    }
    const log = ['System', 'Application', 'Security'].includes(input.log ?? '') ? input.log : 'System'
    const levels = input.level === 'all' ? '1,2,3,4' : input.level === 'warning' ? '2,3' : '1,2'
    const hours = Math.min(Math.max(input.hours ?? 24, 1), 720)
    const count = Math.min(Math.max(input.count ?? 40, 1), 200)

    const res = await ps(`
$f = @{ LogName='${log}'; Level=@(${levels}); StartTime=(Get-Date).AddHours(-${hours}) }
try {
  Get-WinEvent -FilterHashtable $f -MaxEvents ${count} -ErrorAction Stop | ForEach-Object {
    "[$($_.TimeCreated.ToString('MM-dd HH:mm'))] $($_.LevelDisplayName) $($_.ProviderName) (id $($_.Id))"
    "    " + ($_.Message -split "\`n")[0]
  }
} catch { "No matching events in the last ${hours}h, or access denied." }`, 90_000)
    return res.code === 0 ? ok(res.out) : fail(res.out)
  },
}

export const serviceTool: Tool = {
  name: 'service_control',
  description:
    'List services, or start/stop/restart one. Listing is free; changing a service state asks first.',
  mutates: true,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'status', 'start', 'stop', 'restart'] },
      name: { type: 'string', description: 'Service name. Required except for list.' },
      filter: { type: 'string', description: 'For list: substring to match' },
    },
    required: ['action'],
  },
  async run(input: { action: string; name?: string; filter?: string }, ctx: ToolContext): Promise<ToolResult> {
    if (input.action === 'list') {
      const filter = input.filter && /^[\w .-]+$/.test(input.filter) ? input.filter : undefined
      const res = isWindows
        ? await ps(
            `Get-Service ${filter ? `| Where-Object { $_.DisplayName -like '*${filter}*' -or $_.Name -like '*${filter}*' }` : '| Where-Object Status -eq Running'} | Sort-Object Status,Name | ForEach-Object { "  {0,-8} {1,-32} {2}" -f $_.Status, $_.Name, $_.DisplayName }`,
          )
        : await sh(['bash', '-lc', `systemctl list-units --type=service --state=running --no-pager | head -60`])
      return res.code === 0 ? ok(res.out) : fail(res.out)
    }

    const name = input.name
    if (!name || !/^[\w.$-]+$/.test(name)) return fail('A valid service name is required.')

    if (input.action === 'status') {
      const res = isWindows
        ? await ps(`Get-Service -Name '${name}' | Format-List Name,DisplayName,Status,StartType`)
        : await sh(['systemctl', 'status', name])
      return ok(res.out)
    }

    if (!(await ctx.confirm(`${input.action} service`, name))) return fail('Denied by user.')

    const verb = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' }[input.action]
    if (!verb) return fail(`Unknown action "${input.action}".`)

    const res = isWindows
      ? await ps(`${verb} -Name '${name}' -ErrorAction Stop; Get-Service -Name '${name}' | Format-List Name,Status`, 120_000)
      : await sh(['systemctl', input.action, name], 120_000)
    return res.code === 0 ? ok(res.out || `${input.action} ${name}: ok`) : fail(res.out)
  },
}

export const processTool: Tool = {
  name: 'process_list',
  description:
    'List running processes by CPU or memory use. Read-only. Use when diagnosing what is consuming a machine.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: {
      sort: { type: 'string', enum: ['cpu', 'memory'], description: 'Defaults to memory' },
      count: { type: 'integer', description: 'Defaults to 20' },
      name: { type: 'string', description: 'Filter by process name substring' },
    },
  },
  async run(input: { sort?: string; count?: number; name?: string }): Promise<ToolResult> {
    const count = Math.min(Math.max(input.count ?? 20, 1), 100)
    if (!isWindows) {
      const key = input.sort === 'cpu' ? '-pcpu' : '-rss'
      const r = await sh(['bash', '-lc', `ps aux --sort=${key} | head -${count + 1}`])
      return ok(r.out)
    }
    const prop = input.sort === 'cpu' ? 'CPU' : 'WorkingSet'
    const filter = input.name && /^[\w.-]+$/.test(input.name) ? `| Where-Object ProcessName -like '*${input.name}*'` : ''
    const res = await ps(`
Get-Process ${filter} | Sort-Object ${prop} -Descending | Select-Object -First ${count} |
  ForEach-Object { "  {0,-30} pid {1,-8} {2,8:N0} MB  cpu {3,8:N1}s" -f $_.ProcessName, $_.Id, ($_.WorkingSet/1MB), $_.CPU }`)
    return res.code === 0 ? ok(res.out) : fail(res.out)
  },
}

export const driverTool: Tool = {
  name: 'driver_info',
  description:
    'List device drivers, highlighting devices reporting a problem. Read-only. Use when hardware is not working.',
  mutates: false,
  parameters: {
    type: 'object',
    properties: { problems_only: { type: 'boolean', description: 'Defaults to true' } },
  },
  async run(input: { problems_only?: boolean }): Promise<ToolResult> {
    if (!isWindows) {
      const r = await sh(['bash', '-lc', 'lspci -k 2>/dev/null | head -60; echo; dmesg | grep -i "error\\|fail" | tail -20'])
      return ok(r.out || '(no driver information available)')
    }
    const only = input.problems_only !== false
    const res = await ps(`
$d = Get-CimInstance Win32_PnPEntity ${only ? '| Where-Object { $_.ConfigManagerErrorCode -ne 0 }' : ''}
if (-not $d) { "No devices reporting a problem." }
else {
  $d | Select-Object -First 60 | ForEach-Object {
    "  $($_.Name)"
    "    Status: $($_.Status)  ErrorCode: $($_.ConfigManagerErrorCode)  Class: $($_.PNPClass)"
  }
}`)
    return res.code === 0 ? ok(res.out) : fail(res.out)
  },
}

export const systemTools: Tool[] = [
  systemInfoTool,
  diskHealthTool,
  networkDiagnoseTool,
  eventLogTool,
  serviceTool,
  processTool,
  driverTool,
]
