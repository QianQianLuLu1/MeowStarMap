#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS 脚本需 require Node 内置模块 */
'use strict'
/**
 * 手动复现 / 复位 GPU 兼容模式（崩溃自愈）标记文件。
 *
 * 用途：在真实机器上模拟"GPU 崩溃已落盘"状态，或清除该状态恢复硬件加速，
 * 以便验证"崩溃 → 自动降级 → 重启自愈"链路（无需真实坏显卡）。
 *
 * 此脚本仅写入已文档化的文件契约（userData/gpu-fallback.json），
 * 不复制任何业务逻辑；真实决策由 src/main/app/gpu-fallback.ts 负责。
 *
 * 用法：
 *   node scripts/simulate-gpu-crash.cjs            # 写入 fallbackActive=true（模拟已崩溃，下次启动软件渲染）
 *   node scripts/simulate-gpu-crash.cjs --reset    # 删除该标记（恢复硬件加速一次干净重试）
 *   node scripts/simulate-gpu-crash.cjs --userdata "C:\Users\...\AppData\Roaming\NikkiGallery"
 *
 * 注意：修改后请重启应用生效。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function resolveUserData() {
  if (process.env.NIKKI_USERDATA) return process.env.NIKKI_USERDATA
  const idx = process.argv.indexOf('--userdata')
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]

  // 自动探测：在常见 userData 父目录下寻找已含本应用持久化文件的目录
  const candidates = []
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(process.env.APPDATA)
    candidates.push(path.join(os.homedir(), 'AppData', 'Roaming'))
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support'))
  } else {
    candidates.push(path.join(os.homedir(), '.config'))
  }
  for (const base of candidates) {
    try {
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name)
        if (!fs.statSync(dir).isDirectory()) continue
        if (
          fs.existsSync(path.join(dir, 'gpu-pref.json')) ||
          fs.existsSync(path.join(dir, 'gpu-fallback.json'))
        ) {
          return dir
        }
      }
    } catch {
      // 目录不可读时跳过
    }
  }
  // 兜底：给出猜测路径并提示用户显式传入
  const guess =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NikkiGallery')
      : path.join(os.homedir(), '.config', 'NikkiGallery')
  console.warn(`[simulate-gpu-crash] 未自动探测到应用 userData，使用猜测路径：${guess}`)
  console.warn('[simulate-gpu-crash] 如不正确，请用 --userdata <真实路径> 指定（见应用设置→关于/日志目录）。')
  return guess
}

const reset = process.argv.includes('--reset')
const userData = resolveUserData()
const statePath = path.join(userData, 'gpu-fallback.json')

try {
  if (reset) {
    if (fs.existsSync(statePath)) {
      fs.rmSync(statePath, { force: true })
      console.log(`[simulate-gpu-crash] 已删除 ${statePath}`)
    } else {
      console.log(`[simulate-gpu-crash] 标记文件不存在，无需复位：${statePath}`)
    }
    console.log('[simulate-gpu-crash] 已恢复硬件加速（下次启动将使用 GPU 硬件加速，除非用户偏好仍为关闭）。')
  } else {
    const prev = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
      : { consecutiveFailures: 0, fallbackActive: false }
    const next = { ...prev, fallbackActive: true }
    fs.writeFileSync(statePath, JSON.stringify(next))
    console.log(`[simulate-gpu-crash] 已写入标记：${statePath}`)
    console.log('[simulate-gpu-crash] fallbackActive=true → 下次启动将自动禁用硬件加速（软件渲染）。')
    if (prev.fallbackActive) console.log('[simulate-gpu-crash] 该标记已存在，本次为重复写入。')
  }
  console.log('[simulate-gpu-crash] 请重启应用以使变更生效。')
} catch (err) {
  console.error(`[simulate-gpu-crash] 操作失败：${err && err.message ? err.message : err}`)
  process.exit(1)
}
