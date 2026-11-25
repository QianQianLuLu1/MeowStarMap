#!/usr/bin/env node
/**
 * 把 electron-builder 的 win-unpacked 目录打成安装器载荷 zip。
 *
 * 用法：
 *   node scripts/build-payload.mjs --unpacked=<win-unpacked> --out=<payload.zip> [--version=2.5.8]
 *
 * 说明：
 * - 布局必须与 win-unpacked 一致（app.asar / resources / VC++ DLL 等）；
 * - 使用系统 bsdtar（Windows 10+ 自带 tar.exe）打 zip，避免额外依赖；
 * - 同时生成 <out>.json（版本 / 大小 / sha256），供发布流程校验。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match) out[match[1]] = match[2]
  }
  return out
}

function fail(message) {
  console.error(`[build-payload] ✗ ${message}`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))
const projectRoot = process.cwd()
const unpacked = args.unpacked ? path.resolve(projectRoot, args.unpacked) : null
if (!unpacked) fail('缺少 --unpacked=<win-unpacked 目录>')
if (!fs.existsSync(path.join(unpacked, 'resources', 'app.asar'))) {
  fail(`不是有效的 win-unpacked 目录（缺少 resources/app.asar）: ${unpacked}`)
}

const version =
  args.version ??
  (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, '..', 'package.json'), 'utf8'))
      return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
    } catch {
      return '0.0.0'
    }
  })()

const out = args.out
  ? path.resolve(projectRoot, args.out)
  : path.join(path.dirname(unpacked), 'payload.zip')

fs.rmSync(out, { force: true })
fs.mkdirSync(path.dirname(out), { recursive: true })

console.log(`[build-payload] 打包 ${unpacked} -> ${out}`)
execFileSync('tar', ['-a', '-c', '-f', out, '-C', unpacked, '.'], { stdio: 'inherit' })

const buffer = fs.readFileSync(out)
const sha256 = createHash('sha256').update(buffer).digest('hex')
const manifest = {
  version,
  file: path.basename(out),
  size: buffer.length,
  sha256,
  createdAt: new Date().toISOString()
}
fs.writeFileSync(`${out}.json`, JSON.stringify(manifest, null, 2), 'utf8')

console.log(
  `[build-payload] ✓ ${path.basename(out)} ${(buffer.length / 1024 / 1024).toFixed(1)} MB sha256=${sha256.slice(0, 12)}…`
)
