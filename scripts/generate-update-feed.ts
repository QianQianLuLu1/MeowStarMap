#!/usr/bin/env tsx
/**
 * 兼容版本：为自定义安装器生成 electron-updater 兼容的 latest.yml。
 *
 * 用途：自定义安装器取代 NSIS 后，旧客户端仍通过 latest.yml 检查/下载更新；
 * 本脚本以安装器产物为准生成元数据（version / path / sha512 / size / files[]），
 * 供 CI 或本地发布流程随安装包一起上传到 GitHub Release。
 *
 * 用法：
 *   npx tsx scripts/generate-update-feed.ts --installer=release/MeowStarMap-Setup-2.5.8.exe
 *   npx tsx scripts/generate-update-feed.ts --installer=... --version=2.5.8 --out=release/latest.yml
 *
 * 说明：
 * - 默认版本取 package.json 的 version；
 * - 默认输出到安装器同目录的 latest.yml；
 * - sha512 使用 base64（electron-updater 约定），不是十六进制。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface FeedOptions {
  installerPath: string
  version: string
  outputPath: string
  releaseDate: string
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match) out[match[1]] = match[2]
  }
  return out
}

function readPackageVersion(projectRoot: string): string {
  const raw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
  const pkg = JSON.parse(raw) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') {
    throw new Error('package.json 缺少有效的 version 字段')
  }
  return pkg.version
}

function sha512Base64(filePath: string): string {
  const hash = createHash('sha512')
  const fd = fs.openSync(filePath, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
      if (read <= 0) throw new Error(`读取安装器失败: ${filePath}`)
      hash.update(buffer.subarray(0, read))
      position += read
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('base64')
}

function formatLatestYml(input: {
  version: string
  fileName: string
  size: number
  sha512: string
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

export function buildUpdateFeed(argv: string[], projectRoot: string): FeedOptions {
  const args = parseArgs(argv)
  const installerArg = args.installer
  if (installerArg === undefined || installerArg.trim() === '') {
    throw new Error(
      '缺少 --installer=<安装器 exe 路径>（例如 --installer=release/MeowStarMap-Setup-2.5.8.exe）'
    )
  }
  const installerPath = path.resolve(projectRoot, installerArg)
  if (!fs.existsSync(installerPath)) {
    throw new Error(`安装器不存在: ${installerPath}`)
  }
  const version = args.version ?? readPackageVersion(projectRoot)
  const outputPath =
    args.out !== undefined
      ? path.resolve(projectRoot, args.out)
      : path.join(path.dirname(installerPath), 'latest.yml')
  return {
    installerPath,
    version,
    outputPath,
    releaseDate: new Date().toISOString()
  }
}

export function writeUpdateFeed(options: FeedOptions): string {
  const stat = fs.statSync(options.installerPath)
  const fileName = path.basename(options.installerPath)
  const yml = formatLatestYml({
    version: options.version,
    fileName,
    size: stat.size,
    sha512: sha512Base64(options.installerPath),
    releaseDate: options.releaseDate
  })
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })
  const tempPath = path.join(
    path.dirname(options.outputPath),
    `.${path.basename(options.outputPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  )
  try {
    fs.writeFileSync(tempPath, yml, 'utf8')
    fs.renameSync(tempPath, options.outputPath)
  } catch (err) {
    fs.rmSync(tempPath, { force: true })
    throw err
  }
  return options.outputPath
}

function main(): void {
  const projectRoot = process.cwd()
  const options = buildUpdateFeed(process.argv.slice(2), projectRoot)
  const written = writeUpdateFeed(options)
  console.log(
    `[generate-update-feed] 已生成 ${written}（version=${options.version}，安装器=${options.installerPath}）`
  )
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main()
}
