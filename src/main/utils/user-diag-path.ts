/**
 * 用户友好诊断目录的单一权威（叶子模块，零项目内依赖，避免循环依赖）。
 *
 * 面向用户的关键诊断文件（startup-errors.log / diag.log / 崩溃 dump）统一输出到
 * 「文档/NikkiGallery/Diagnostics」，而非隐藏的 AppData，确保普通用户无需进入
 * 系统深层目录即可找到。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

export const PRODUCT_DIAG_DIRNAME = 'NikkiGallery'
export const DIAG_SUBDIR = 'Diagnostics'

export interface UserDiagDirDeps {
  /** 返回「文档」目录绝对路径；抛错/空值视为不可用，进入下候选。 */
  getDocumentsPath?: () => string
  getHomedir?: () => string
  getTmpdir?: () => string
}

function tryMkdir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * 计算用户友好诊断目录。
 * 候选链（首个可创建者采用）：
 *   1) <documents>/NikkiGallery/Diagnostics
 *   2) <homedir>/NikkiGallery/Diagnostics
 *   3) <tmpdir>/NikkiGallery-Diagnostics
 * 任何候选抛错都被吞掉，不阻塞启动；终极兜底返回 tmpdir 候选字符串。
 */
export function getUserFacingDiagDir(deps: UserDiagDirDeps = {}): string {
  const getDocs = deps.getDocumentsPath
  const getHome = deps.getHomedir ?? (() => os.homedir())
  const getTmp = deps.getTmpdir ?? (() => os.tmpdir())

  const candidates: string[] = []
  if (getDocs) {
    try {
      const d = getDocs()
      if (d) candidates.push(path.join(d, PRODUCT_DIAG_DIRNAME, DIAG_SUBDIR))
    } catch {
      /* 文档目录不可用时忽略，进入下候选 */
    }
  }
  try {
    const h = getHome()
    if (h) candidates.push(path.join(h, PRODUCT_DIAG_DIRNAME, DIAG_SUBDIR))
  } catch {
    /* 忽略 */
  }
  try {
    const t = getTmp()
    if (t) candidates.push(path.join(t, `${PRODUCT_DIAG_DIRNAME}-${DIAG_SUBDIR}`))
  } catch {
    /* 忽略 */
  }

  for (const dir of candidates) {
    if (tryMkdir(dir)) return dir
  }
  // 全部创建失败时，返回首个候选（写入失败由调用方静默处理）
  return candidates[0] ?? path.join(os.tmpdir(), `${PRODUCT_DIAG_DIRNAME}-${DIAG_SUBDIR}`)
}
