/**
 * 待审 app.asar 的选取与解包根派生 —— pre-dist-check 与 verify-nikkisync-link 的共享单一事实源。
 *
 * 存在理由（DEBT-054 收口）：verify-nikkisync-link 的 packedMigrationsReadable 原先自己持有一份
 * `findAsarUnpacked` 同名副本（递归 readdir、取首个命中），与禁串步的选择器不同源 ⇒ 两棵完整树并存时
 * 诊断会验到陈旧树上（假绿）。2026-11-04 起两者共用本模块的唯一判据：解包根由**已解析**的
 * app.asar 派生（`.unpacked` 兄弟），不命中即 fail-closed，绝不回退目录扫描。
 */
import * as fs from 'fs'
import * as path from 'path'

/**
 * 纯函数：确定 --verify-asar 要审哪个 app.asar。
 * release/ 下可同时躺着几棵树（上次成功的、失败残留的、解压中途的 *.tmp），
 * 因此**全链只允许这一个选择器**：解包根由它的返回值派生（见 deriveUnpackedTarget）。
 * 不得再用「递归 readdir、取首个命中」那套判据 —— 2026-11-04 取证实测它在两棵完整树
 * 并存时返回陈旧树的 app.asar.unpacked，而禁串步审的是现役树，两条校验各验各的树 ⇒ 假绿。
 * 优先级固定：① --asar=<path> 显式指定（electronDist 旁路打包时用）；
 * ② release/win-unpacked/resources/app.asar（electron-builder win 解包目录的固定名）；
 * ③ 任何 *.tmp 目录段一律拒绝。相对路径按 releaseDir 的父目录（仓库根）解析。
 */
export function resolveVerifyAsarTarget(
  argv: string[],
  releaseDir: string
): { asarPath: string | null; reason: string } {
  const override = argv.find((a) => a.startsWith('--asar='))
  let target: string
  if (override !== undefined) {
    const raw = override.slice('--asar='.length).trim()
    if (raw === '') {
      return {
        asarPath: null,
        reason: '--asar 需要显式路径，形如 --asar=release/win-unpacked/resources/app.asar'
      }
    }
    const root = path.dirname(releaseDir)
    target = path.isAbsolute(raw) ? raw : path.join(root, raw)
  } else {
    target = path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar')
  }
  if (target.split(/[\\/]/).some((seg) => seg.endsWith('.tmp'))) {
    return { asarPath: null, reason: `拒绝校验解压中途目录：${target}` }
  }
  if (!fs.existsSync(target)) {
    return {
      asarPath: null,
      reason:
        `未找到待审产物 ${target}：若走的是 electronDist 旁路打包（解包目录名非 win-unpacked），` +
        '请传 --asar=<path>'
    }
  }
  return { asarPath: target, reason: '' }
}

/** deriveUnpackedTarget 的判定结果：解包根、其对应的 app 输出根、以及不成立时的原因 */
export interface UnpackedTarget {
  unpackedRoot: string | null
  appOutDir: string | null
  reason: string
}

/**
 * 纯函数：由**已解析**的待审 app.asar 派生它的解包根与 app 输出根。
 *
 * 存在理由：原生二进制校验步原先自己递归扫 release/ 取首个 app.asar.unpacked，与禁串步
 * 的选择器不同源 ⇒ 两棵完整树并存时验到旧产物上（假绿，取证见 resolveVerifyAsarTarget 头注）。
 * 判据收敛为唯一一条：解包根 = `asarPath` 的 `.unpacked` 兄弟。不命中即返回 reason 供上层
 * **fail-closed**，绝不回退目录扫描；`.tmp` 拒绝与「默认路径缺失即 null」都在
 * resolveVerifyAsarTarget 里，本函数继承之。exists 以探针注入（同 missingPackedCapabilityArtifacts
 * 的形状），单测不触磁盘；探针被调用的次数与入参是「没有偷偷扫目录」的可证判据。
 */
export function deriveUnpackedTarget(
  asarPath: string | null,
  exists: (p: string) => boolean
): UnpackedTarget {
  if (asarPath === null) {
    return {
      unpackedRoot: null,
      appOutDir: null,
      reason:
        '待审 app.asar 未确定，解包根无从派生（原因见 resolveVerifyAsarTarget）：不回落目录扫描'
    }
  }
  const candidate = `${asarPath}.unpacked`
  if (!exists(candidate)) {
    return {
      unpackedRoot: null,
      appOutDir: null,
      reason:
        `未找到待审产物对应的解包目录 ${candidate}：` +
        '请先执行 electron-builder 打包；若解包目录名非 win-unpacked（electronDist 旁路），请传 --asar=<path>'
    }
  }
  // app.asar.unpacked 与 app.asar 同在 resources/ 下，app 输出根是它的上两级
  return { unpackedRoot: candidate, appOutDir: path.dirname(path.dirname(candidate)), reason: '' }
}
