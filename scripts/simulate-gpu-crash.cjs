#!/usr/bin/env node

'use strict'
/**
 * 手动复现 / 复位 GPU 兼容模式（崩溃自愈）标记文件。
 *
 * 用途：在真实机器上模拟"GPU 崩溃已落盘"状态，或清除该状态恢复硬件加速，
 * 以便验证"崩溃 → 自动降级 → 重启自愈"链路（无需真实坏显卡）。
 *
 * 写契约（2026-11-17 取证存储统一收口）：标记落「取证根/gpu-fallback.json」，
 * 取证根复用单一真相源 src/main/utils/forensics-dir.ts（零 electron 依赖叶子模块），
 * 与生产读写侧 src/main/app/gpu-fallback.ts 同源；不再扫描/猜测 userData。
 * 因需 require TS 真相源，本脚本经 tsx 运行（plain node 直跑会给出指引报错）。
 *
 * 用法：
 *   npx tsx scripts/simulate-gpu-crash.cjs                 # 默认取证根（homedir 回退链）写入 fallbackActive=true
 *   npx tsx scripts/simulate-gpu-crash.cjs --reset         # 删除该标记（恢复硬件加速一次干净重试）
 *   npx tsx scripts/simulate-gpu-crash.cjs --exe "release\win-unpacked\喵星图.exe"
 *                                                          # install 分支：exe 同目录 Diagnostics
 *   npx tsx scripts/simulate-gpu-crash.cjs --userdata "<取证根目录>"
 *                                                          # 显式指定取证根（NIKKI_USERDATA 环境变量同义）
 *
 * 落点差异提示：dev 应用经 Documents 提供器把取证根落在「Documents\喵星图\Diagnostics」，
 * 本脚本默认态无该提供器、走 homedir 回退链；两者不一致时用 --userdata/NIKKI_USERDATA
 * 显式指定应用实际取证根（见启动 diag.log 或应用设置→关于/日志目录）。
 *
 * 注意：修改后请重启应用生效。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 惰性装载取证真相源；plain node（无 tsx 钩子）require TS 会失败，返回 null 由调用方给指引。 */
function loadForensics() {
  try {
    return require('../src/main/utils/forensics-dir.ts')
  } catch {
    return null
  }
}

function argValue(argv, flag) {
  const idx = argv.indexOf(flag)
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : null
}

/**
 * 主流程（依赖注入供单测）：返回退出码（0 成功 / 1 失败）。
 * 解析优先级：--userdata / NIKKI_USERDATA（显式取证根覆盖）→ --exe（install 分支注入）
 * → 真相源默认回退链。--userdata 与 --exe 互斥。
 */
function run(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2)
  const env = deps.env ?? process.env
  const log = deps.log ?? ((message) => console.log(message))
  const warn = deps.warn ?? ((message) => console.warn(message))
  const error = deps.error ?? ((message) => console.error(message))

  const reset = argv.includes('--reset')
  // 值形态校验：--exe/--userdata 的值缺失、空串或以 -- 开头（把另一个开关误当值）一律报错退出。
  // 不校验时 `--exe --reset` 会把 --reset 当路径写错根，`--userdata ""` 静默回落默认链（写错根且无提示）。
  for (const flag of ['--userdata', '--exe']) {
    const idx = argv.indexOf(flag)
    if (idx === -1) continue
    const value = argv[idx + 1]
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      error(`[simulate-gpu-crash] ${flag} 需要一个非空且不以 -- 开头的值（当前缺失、为空串或误把开关当值）。`)
      return 1
    }
  }
  const explicitRoot = argValue(argv, '--userdata') || env.NIKKI_USERDATA || null
  const exeArg = argValue(argv, '--exe')
  // 相对 exe 路径按 cwd 解析为绝对路径：真相源的可写性探测只接受绝对路径，
  // 不解析会让相对入参静默回落 homedir 链（写错根）
  const exePath = exeArg ? path.resolve(deps.cwd ?? process.cwd(), exeArg) : null

  try {
    if (explicitRoot && exePath) {
      error('[simulate-gpu-crash] --userdata 与 --exe 互斥，请只指定一种取证根定位方式。')
      return 1
    }

    let statePath
    if (explicitRoot) {
      statePath = path.join(explicitRoot, 'gpu-fallback.json')
    } else {
      const forensics = deps.forensics !== undefined ? deps.forensics : loadForensics()
      if (!forensics) {
        error(
          '[simulate-gpu-crash] 无法装载取证真相源 forensics-dir.ts：请经 tsx 运行' +
            '（npx tsx scripts/simulate-gpu-crash.cjs），plain node 不支持 require TS。'
        )
        return 1
      }
      if (exePath) {
        forensics.setForensicsEnvProvider(() => ({
          isPackaged: true,
          defaultApp: false,
          exePath
        }))
      } else {
        forensics.setForensicsEnvProvider(null)
      }
      statePath = forensics.getForensicsFilePath('gpu-fallback.json')
      if (!exePath) {
        warn(
          '[simulate-gpu-crash] 默认态走 homedir 回退链；dev 应用经 Documents 提供器落' +
            ' Documents\\喵星图\\Diagnostics，可能与此处不一致——不一致时请用' +
            ' --userdata/NIKKI_USERDATA 显式指定应用实际取证根。'
        )
      }
    }

    if (reset) {
      if (fs.existsSync(statePath)) {
        fs.rmSync(statePath, { force: true })
        log(`[simulate-gpu-crash] 已删除 ${statePath}`)
      } else {
        log(`[simulate-gpu-crash] 标记文件不存在，无需复位：${statePath}`)
      }
      log('[simulate-gpu-crash] 已恢复硬件加速（下次启动将使用 GPU 硬件加速，除非用户偏好仍为关闭）。')
    } else {
      const prev = fs.existsSync(statePath)
        ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
        : { consecutiveFailures: 0, fallbackActive: false }
      const next = { ...prev, fallbackActive: true }
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(statePath, JSON.stringify(next))
      log(`[simulate-gpu-crash] 已写入标记：${statePath}`)
      log('[simulate-gpu-crash] fallbackActive=true → 下次启动将自动禁用硬件加速（软件渲染）。')
      if (prev.fallbackActive) log('[simulate-gpu-crash] 该标记已存在，本次为重复写入。')
    }
    log('[simulate-gpu-crash] 请重启应用以使变更生效。')
    return 0
  } catch (err) {
    error(`[simulate-gpu-crash] 操作失败：${err && err.message ? err.message : err}`)
    return 1
  }
}

module.exports = { run }

if (require.main === module) {
  process.exit(run())
}
