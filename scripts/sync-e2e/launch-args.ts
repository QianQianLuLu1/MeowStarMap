/**
 * E2E 启动器命令行参数解析（纯函数，供 launch-server.ts 与单测复用，
 * 遵循 scripts/AGENTS.md「核心逻辑导出为纯函数供单测」）。
 *
 * 支持flags：--host / --port / --pair-host / --data-dir / --qr / --serve。
 * 校验策略：--port 必须为 0–65535 的整数；未知参数一律抛错
 * （防止拼写错误如 --prot 静默回落默认端口 0）；--serve 为 no-op
 * （常驻即默认行为，仅为兼容 docs/sync-integration 的文档历史写法）。
 */

export interface LaunchArgs {
  host: string
  port: number
  pairHost: string | null
  dataDir: string | null
  qr: boolean
}

export function parseArgs(argv: readonly string[]): LaunchArgs {
  const args: LaunchArgs = { host: '127.0.0.1', port: 0, pairHost: null, dataDir: null, qr: false }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    switch (argv[i]) {
      case '--host':
        args.host = value ?? args.host
        i++
        break
      case '--port': {
        const port = Number(value ?? 0)
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`invalid --port: ${value ?? '<missing>'} (expected integer 0..65535)`)
        }
        args.port = port
        i++
        break
      }
      case '--pair-host':
        args.pairHost = value ?? null
        i++
        break
      case '--data-dir':
        args.dataDir = value ?? null
        i++
        break
      case '--qr':
        args.qr = true
        break
      case '--serve':
        // 常驻即默认行为；接受该标志仅为兼容文档历史写法
        break
      default:
        throw new Error(
          `unknown argument: ${String(argv[i])} (supported: --host --port --pair-host --data-dir --qr --serve)`
        )
    }
  }
  return args
}
