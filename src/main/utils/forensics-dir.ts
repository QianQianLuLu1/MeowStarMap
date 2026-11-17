/**
 * 取证根目录单一真相源（叶子模块，零 electron 依赖，provider 注入——同 user-diag-path 模式）。
 *
 * 2026-11-17 统一收口：所有「问题取证清单」相关文件（diag.log / startup-errors.log /
 * chromium-debug.log / heartbeat.json / last-exit.json / gpu-fallback.json / gpu-pref.json /
 * boot-ok.marker / second-instance-ack.json / *.dmp / logs 子目录）统一落本模块给出的
 * 根目录，替代此前 Documents / userData / 自定义目录三处分散存储：
 *
 * 候选链：
 *   1) 打包态（isPackaged===true 且 defaultApp!==true）：<exe 所在目录>\Diagnostics，
 *      可写性探测通过后采用——作为「窗口拉不起时的应急取证入口」（用户可直接到安装
 *      目录查找），也是「导出诊断包」的归集来源；
 *   2) 其余（dev / 探测失败 / provider 缺失或抛错）：回落 getUserFacingDiagDir()
 *      （Documents/喵星图/Diagnostics → homedir → tmpdir）。
 *
 * 为什么不能只凭 isPackaged 判别 dev：Electron 41 下 `electron.exe <显式 app 目录>`
 * 的 app.isPackaged === true（2026-11-17 探针实证）——e2e launchBuiltApp 会误入安装
 * 分支把取证写进 node_modules。process.defaultApp 在该形态恒为 true、打包 exe 恒为
 * false，是权威的 dev 信号。
 */
import fs from 'fs'
import path from 'path'
import { getUserFacingDiagDir } from './user-diag-path'

/** 安装目录下取证子目录名（磁盘路径分段，须跨语言稳定，非 UI 文案） */
export const FORENSICS_DIRNAME = 'Diagnostics'
/** electron-log / logger 主日志在取证根下的子目录名 */
export const FORENSICS_LOGS_SUBDIR = 'logs'

/**
 * 取证根目录平铺的文件白名单（迁移与诊断包 manifest 共用的单一清单）。
 * logs/ 子目录（main-*.log / faults-*.jsonl / main.log / scan-log.jsonl）与
 * crashes（*.dmp 平铺在根）、nikkisync/ 子目录不在此列。
 */
export const FORENSICS_ROOT_FILE_NAMES = [
  'diag.log',
  'startup-errors.log',
  'chromium-debug.log',
  'chromium-debug.log.old',
  'gpu-fallback.json',
  'gpu-pref.json',
  'heartbeat.json',
  'last-exit.json',
  'second-instance-ack.json',
  'boot-ok.marker'
] as const

export interface ForensicsEnv {
  isPackaged: boolean
  /** Electron `process.defaultApp`（electron.exe + 显式 app 目录形态为 true） */
  defaultApp: boolean
  /** Electron `app.getPath('exe')` 绝对路径 */
  exePath: string
}

let forensicsEnvProvider: (() => ForensicsEnv | null) | null = null
let resolvedRoot: string | null = null
let resolvedSource: 'install' | 'fallback' | null = null

/**
 * 注册运行环境提供器（主进程入口 index.ts 模块加载早期调用）。
 * 注册/清空都会使解析缓存失效（兼作测试重置缝）。
 */
export function setForensicsEnvProvider(fn: (() => ForensicsEnv | null) | null): void {
  forensicsEnvProvider = fn
  resolvedRoot = null
  resolvedSource = null
}

/**
 * 可写性探测：mkdir（递归）+ W_OK。
 * 内联同构 path-safety.ensureWritableDir 而不 import 它——其依赖链（dir-manager →
 * electron/logger）会破坏本模块的零 electron 叶子约束（CI 惰性环境不可用）。
 */
function probeWritableDir(dir: string): boolean {
  try {
    if (!dir || !path.isAbsolute(dir)) return false
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function resolveForensicsRoot(): { root: string; source: 'install' | 'fallback' } {
  let env: ForensicsEnv | null = null
  try {
    env = forensicsEnvProvider?.() ?? null
  } catch {
    env = null
  }
  if (
    env &&
    env.isPackaged === true &&
    env.defaultApp !== true &&
    typeof env.exePath === 'string' &&
    env.exePath.trim() !== ''
  ) {
    const installDir = path.join(path.dirname(env.exePath), FORENSICS_DIRNAME)
    if (probeWritableDir(installDir)) {
      return { root: installDir, source: 'install' }
    }
    // 安装目录不可写（自定义装到 Program Files 等，asInvoker 被 ACL 拒绝）→ 回落
  }
  return { root: getUserFacingDiagDir(), source: 'fallback' }
}

/** 取证根目录（模块级单次解析缓存；provider 重置可使其失效） */
export function getForensicsRoot(): string {
  if (resolvedRoot === null) {
    const resolved = resolveForensicsRoot()
    resolvedRoot = resolved.root
    resolvedSource = resolved.source
  } else if (resolvedSource === 'fallback' && getUserFacingDiagDir() !== resolvedRoot) {
    // R-a2 缓存缝：setDocumentsPathProvider（user-diag-path 叶子模块）注册/换值
    // 不会反向通知本模块失效缓存——fallback 态结果依赖 documents 候选链，
    // 每次读取时比对链上现值，漂移即重解析（install 态缓存不受影响：其根只依赖
    // exe 目录，env provider 换值经 setForensicsEnvProvider 已失效缓存）。
    const resolved = resolveForensicsRoot()
    resolvedRoot = resolved.root
    resolvedSource = resolved.source
  }
  return resolvedRoot
}

/** 本进程实际采用的候选（迁移与诊断包 manifest 消费：判定是否处于回落态） */
export function getForensicsRootSource(): 'install' | 'fallback' {
  if (resolvedSource === null) getForensicsRoot()
  return resolvedSource as 'install' | 'fallback'
}

/**
 * 取证根下单个文件的绝对路径。
 * 入参守卫：仅接受纯文件名段（非空、无路径分隔符、无 ..），防止内部调用方拼出
 * 越权子路径——取证文件布局是「根目录平铺 + logs/ 子目录」两种，后者走
 * getForensicsLogsDir()。
 */
export function getForensicsFilePath(name: string): string {
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..')
  ) {
    throw new Error(
      `forensics-dir: illegal file name "${String(name)}"; expected a plain file name without separators`
    )
  }
  return path.join(getForensicsRoot(), name)
}

/** 取证根下的 electron-log / logger 日志子目录 */
export function getForensicsLogsDir(): string {
  return path.join(getForensicsRoot(), FORENSICS_LOGS_SUBDIR)
}

/**
 * 历史版本写在 userData 根级的 6 个取证文件（与 forensics-migrate.ts 的
 * LEGACY_USERDATA_ROOT_FILE_NAMES 同集；此处为模块加载期同步版，供 index.ts
 * 在 recordBootLevel 之前接线——升级首启旧版 GPU 档位与用户硬件加速偏好
 * 必须先于 GPU 决策到达取证根，否则被静默架空）。
 */
const LEGACY_USERDATA_ROOT_FILE_NAMES = [
  'gpu-fallback.json',
  'gpu-pref.json',
  'heartbeat.json',
  'last-exit.json',
  'boot-ok.marker',
  'second-instance-ack.json'
] as const

/**
 * R-a3（审查修复轮）：userData 根级历史取证文件 → 取证根，同步、skipExisting
 * 语义（目标存在则保留源，保护本次启动已写的新鲜证据）、幂等、fail-open。
 * 零 electron：userData 路径经入参注入；同路径（userDataDir===root）直接返回。
 * 与 forensics-migrate.migrateLegacyUserDataRoot（异步版，阶段 2 兜底）同判据。
 */
export function migrateLegacyUserDataRootSync(userDataDir: string): void {
  try {
    if (!userDataDir) return
    const root = getForensicsRoot()
    if (userDataDir === root) return
    for (const name of LEGACY_USERDATA_ROOT_FILE_NAMES) {
      const src = path.join(userDataDir, name)
      const dst = path.join(root, name)
      try {
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue
        fs.renameSync(src, dst)
      } catch {
        // 单文件失败（占用/跨卷）跳过：下次启动再迁，不阻塞 boot
      }
    }
  } catch {
    // 取证根不可解析等极端场景：静默降级，绝不影响启动
  }
}
