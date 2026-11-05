/**
 * dev 假更新源：在开发机上冒充一个 generic provider 更新源，用来在真实界面里验证
 * 「有更新 / 无更新 / 源未就绪 / 连不上」四条分支（判据见
 * docs/plans/2026-11-05-fix-update-check-network-busy-misreport.md §六）。
 *
 * 铁律一：产物只写 `--dir`（默认 `.cache/dev-update-feed`），**绝不写 `release/`**。
 * CI 发布步骤的 glob 是 `release/latest*.yml`，假 `latest.yml` 一旦落进 release/ 就会被
 * 当成真元数据发出去，比本轮修的误报更危险。参数校验层直接拒绝（可单测）。
 * 铁律二：只服务本次生成的两个确切文件名（latest.yml 与假包），不做目录遍历。
 *
 * 用法：
 *   npx tsx scripts/serve-dev-update-feed.ts --version 9.9.9 --port 8123
 *   MEOW_DEV_UPDATE_FEED=1 npm run dev        # 另开一个终端
 *   npx tsx scripts/serve-dev-update-feed.ts --version 9.9.9 --no-yml   # 复现「源未就绪」
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const DEFAULT_PORT = 8123
const FEED_FILE = 'latest.yml'
const RELEASE_SEGMENT = /[\\/]release([\\/]|$)/i
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

export interface ServeFeedArgs {
  /** 监听端口 */
  port: number
  /** 假更新源宣告的版本号 */
  version: string
  /** 假产物落盘目录（绝对路径） */
  dir: string
  /** 是否写 latest.yml；false 用于复现「GitHub 可达但更新元数据未就绪」 */
  writeFeed: boolean
}

export type ServeFeedArgsResult = { ok: true; args: ServeFeedArgs } | { ok: false; error: string }

/**
 * CLI 参数解析与校验（纯函数，供单测直接调用）。
 * 拒绝：未知参数、端口越界或非整数、非法 semver、产物目录落在任何名为 release 的目录内。
 */
export function parseServeFeedArgs(argv: string[], root: string): ServeFeedArgsResult {
  let port = DEFAULT_PORT
  let version = ''
  let dir: string | null = null
  let writeFeed = true

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--no-yml') {
      writeFeed = false
      continue
    }
    if (token === '--port' || token === '--version' || token === '--dir') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `参数 ${token} 缺少取值` }
      }
      i += 1
      if (token === '--port') {
        if (!/^\d+$/.test(value)) {
          return { ok: false, error: `--port 必须是整数，收到 ${JSON.stringify(value)}` }
        }
        const parsed = Number(value)
        if (parsed < 1024 || parsed > 65535) {
          return {
            ok: false,
            error: `--port 必须在 1024-65535（避开占用中的 5173），收到 ${parsed}`
          }
        }
        port = parsed
      } else if (token === '--version') {
        version = value
      } else {
        dir = value
      }
      continue
    }
    return {
      ok: false,
      error: `未知参数 ${JSON.stringify(token)}（支持 --version / --port / --dir / --no-yml）`
    }
  }

  if (!version)
    return { ok: false, error: '必须指定 --version（合法语义化版本，如 9.9.9 或 2.5.8-beta）' }
  if (!SEMVER_RE.test(version)) {
    return { ok: false, error: `--version 不是合法语义化版本，收到 ${JSON.stringify(version)}` }
  }

  // 宿主绑定的真 IO 路径（第 2 档）；release 判定用串形态正则，不依赖 path.sep 与平台开关
  const resolvedDir = path.resolve(root, dir ?? path.join('.cache', 'dev-update-feed'))
  if (RELEASE_SEGMENT.test(resolvedDir)) {
    return {
      ok: false,
      error:
        `--dir 解析结果落在 release/ 之内：${resolvedDir}\n` +
        '假 latest.yml 混进 release/ 会被 CI 的 release/latest*.yml 上传 glob 当真元数据发出去；' +
        '请用默认目录或 release 之外的路径'
    }
  }

  return { ok: true, args: { port, version, dir: resolvedDir, writeFeed } }
}

/** 假安装包文件名（与 electron-builder 的 NSIS 产物命名同形，便于肉眼比对） */
export function feedPayloadName(version: string): string {
  return `MeowStarMap-Setup-${version}.exe`
}

/**
 * 组装 electron-builder 口径的 latest.yml（sha512 用 base64，字段顺序与真实产物一致）。
 * 真实样本：version / files[{url,sha512,size}] / path / sha512 / releaseDate。
 */
export function buildLatestYml(input: {
  version: string
  fileName: string
  sha512: string
  size: number
  releaseDate: string
}): string {
  return [
    `version: ${input.version}`,
    'files:',
    `  - url: ${input.fileName}`,
    `    sha512: ${input.sha512}`,
    `    size: ${input.size}`,
    `path: ${input.fileName}`,
    `sha512: ${input.sha512}`,
    `releaseDate: '${input.releaseDate}'`,
    ''
  ].join('\n')
}

/** base64 sha512（electron-updater 的校验口径） */
export function sha512Base64(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64')
}

function main(argv: string[]): void {
  const parsed = parseServeFeedArgs(argv, ROOT)
  if (!parsed.ok) {
    console.error(`[dev-update-feed] ✖ ${parsed.error}`)
    process.exit(1)
  }
  const { port, version, dir, writeFeed } = parsed.args
  const fileName = feedPayloadName(version)

  mkdirSync(dir, { recursive: true })
  // 假包只需要「存在且字节稳定」：sha512 现算，保证 yml 与文件自洽（否则下载校验必失败）
  const payloadPath = path.join(dir, fileName)
  if (!existsSync(payloadPath)) {
    writeFileSync(payloadPath, randomBytes(4096))
  }
  const payload = readFileSync(payloadPath)
  const sha512 = sha512Base64(payload)
  const feedPath = path.join(dir, FEED_FILE)
  if (writeFeed) {
    writeFileSync(
      feedPath,
      buildLatestYml({
        version,
        fileName,
        sha512,
        size: payload.length,
        releaseDate: new Date().toISOString()
      }),
      'utf-8'
    )
  } else if (existsSync(feedPath)) {
    // --no-yml 是刻意复现「可达但源未就绪」：删掉旧元数据，否则服务仍会命中上一轮留下的 yml
    writeFileSync(feedPath + '.bak', readFileSync(feedPath))
    writeFileSync(feedPath, '', 'utf-8')
  }

  const allowed = new Map<string, string>()
  if (writeFeed) allowed.set(FEED_FILE, feedPath)
  allowed.set(fileName, payloadPath)

  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '')
    const file = allowed.get(name)
    if (!file) {
      // 只服务白名单内的确切文件名：404 而不是目录遍历
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found\n')
      console.log(`[dev-update-feed] 404 ${name}`)
      return
    }
    res.writeHead(200, { 'Content-Length': String(readFileSync(file).length) })
    res.end(readFileSync(file))
    console.log(`[dev-update-feed] 200 ${name}`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    const hint =
      err.code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用（electron-vite dev 用 5173；换一个 --port 并同步改 dev-app-update.yml 的 url）`
        : err.message
    console.error(`[dev-update-feed] ✖ 起服务失败：${hint}`)
    process.exit(1)
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[dev-update-feed] ✅ http://127.0.0.1:${port}/  version=${version}  dir=${dir}`)
    console.log(
      writeFeed
        ? `[dev-update-feed] 已写 ${FEED_FILE} ⇒ 客户端应报「发现新版本」`
        : `[dev-update-feed] 未提供 ${FEED_FILE} ⇒ 客户端应报「未获取到可用的更新信息」（源未就绪）`
    )
    console.log(
      '[dev-update-feed] 另开终端执行：MEOW_DEV_UPDATE_FEED=1 npm run dev，然后到 设置→关于→检查更新'
    )
    console.log(
      '[dev-update-feed] Ctrl+C 结束服务；默认不要点「下载更新」，若点了请删 %LOCALAPPDATA%\\meow-star-map-updater-dev'
    )
  })
}

// 仅在以脚本方式直接运行时启动；被测试导入时不执行
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('serve-dev-update-feed.ts')) {
  main(process.argv.slice(2))
}
