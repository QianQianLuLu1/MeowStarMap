#!/usr/bin/env node
/**
 * 一键构建自研安装器（Tauri）：
 *   1. 从 win-unpacked 生成 payload.zip + sha256 清单；
 *   2. 调用 tauri build --no-bundle 产出安装器 exe；
 *   3. 复制为 release/MeowStarMap-Installer-<version>.exe；
 *   4. 生成 latest-installer.yml（electron-updater 兼容，指向安装器）。
 *
 * 用法（仓库根目录）：
 *   node scripts/build-installer.mjs
 *   node scripts/build-installer.mjs --payload-only
 *   node scripts/build-installer.mjs --unpacked=release/win-unpacked --out=release/payload.zip
 *
 * 说明：本机 Rust 未写 PATH，脚本会自动前置 %USERPROFILE%\.cargo\bin。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const installerDir = path.join(root, 'installer')


function argValue(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit === undefined ? fallback : hit.slice(prefix.length)
}

const payloadOnly = process.argv.includes('--payload-only')
const unpacked = path.resolve(root, argValue('unpacked', 'release/win-unpacked'))
const payloadOut = path.resolve(root, argValue('out', 'installer/payload.zip'))

function fail(message) {
  console.error(`[build-installer] ✗ ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) {
    fail(`${command} 启动失败: ${result.error.message}`)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
if (typeof version !== 'string' || version.length === 0) fail('package.json 缺少 version')

if (!fs.existsSync(path.join(installerDir, 'node_modules'))) {
  fail('installer/node_modules 不存在，请先执行 `cd installer && npm install`')
}

if (!fs.existsSync(path.join(unpacked, 'resources', 'app.asar'))) {
  fail(`win-unpacked 不存在或缺 resources/app.asar（${unpacked}）；请先执行 npm run build 并 electron-builder --win --dir`)
}

console.log(`[build-installer] 载荷源: ${unpacked}`)
console.log(`[build-installer] 载荷输出: ${payloadOut}`)
run(process.execPath, [
  path.join(installerDir, 'scripts', 'build-payload.mjs'),
  `--unpacked=${unpacked}`,
  `--out=${payloadOut}`,
  `--version=${version}`
])

if (payloadOnly) {
  console.log('[build-installer] ✓ --payload-only，已生成载荷')
  process.exit(0)
}

const cargoBin = path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin')
const env = { ...process.env }
if (fs.existsSync(cargoBin)) {
  // Windows 环境变量名大小写不敏感，但 Node 的 env 对象保留大小写（本机为 Path）；
  // 必须改已经存在的键，否则会同时存在 Path/PATH 两个键，cmd 可能取到被清空的那个。
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  env[pathKey] = `${cargoBin}${path.delimiter}${env[pathKey] ?? ''}`
}

console.log('[build-installer] 构建 Tauri 安装器（tauri build --no-bundle）…')
const tauriCli = path.join(installerDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
if (!fs.existsSync(tauriCli)) fail(`未找到 tauri CLI: ${tauriCli}`)
run(process.execPath, [tauriCli, 'build', '--no-bundle'], { cwd: installerDir, env })

const builtExe = path.join(installerDir, 'src-tauri', 'target', 'release', 'meowstarmap-installer.exe')
if (!fs.existsSync(builtExe)) {
  fail(`未找到构建产物: ${builtExe}`)
}

const releaseDir = path.join(root, 'release')
fs.mkdirSync(releaseDir, { recursive: true })
const installerExe = path.join(releaseDir, `MeowStarMap-Installer-${version}.exe`)
fs.copyFileSync(builtExe, installerExe)
console.log(`[build-installer] ✓ 安装器: ${path.relative(root, installerExe)}`)

// 运行时安装器会在自身目录查找 payload.zip；发布前把载荷放到安装器 exe 同级
const releasePayload = path.join(releaseDir, 'payload.zip')
if (fs.existsSync(payloadOut)) {
  fs.copyFileSync(payloadOut, releasePayload)
  console.log(`[build-installer] ✓ 载荷: ${path.relative(root, releasePayload)}`)
}

const latestYml = path.join(releaseDir, 'latest-installer.yml')
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
if (!fs.existsSync(tsxCli)) fail(`未找到 tsx CLI: ${tsxCli}`)
run(process.execPath, [
  tsxCli,
  path.join(root, 'scripts', 'generate-update-feed.ts'),
  `--installer=${installerExe}`,
  `--version=${version}`,
  `--out=${latestYml}`
])
console.log(`[build-installer] ✓ 更新元数据: ${path.relative(root, latestYml)}`)
console.log('[build-installer] 完成')
