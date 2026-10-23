/**
 * 环境健康诊断脚本
 *
 * 聚合检查项目运行所需的关键依赖与资源，输出结构化诊断结果。
 * exit 0 = 全部健康，exit 1 = 存在降级项。
 *
 * 用法：npm run doctor
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

// ─── 诊断结果类型 ───────────────────────────────────────────

type CheckStatus = 'OK' | 'DEGRADED'

interface CheckResult {
  name: string
  status: CheckStatus
  message: string
}

// ─── 各项检查 ───────────────────────────────────────────────

function checkNodeVersion(): CheckResult {
  const name = 'Node 版本'
  try {
    // 读取 package.json 中的 engines.node 约束
    const pkgPath = path.join(ROOT, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const constraint: string | undefined = pkg?.engines?.node
    if (!constraint) {
      return { name, status: 'DEGRADED', message: 'package.json 中未定义 engines.node' }
    }

    const currentVersion = process.version // e.g. v20.11.0
    const major = parseInt(currentVersion.slice(1).split('.')[0], 10)

    // 解析 ">=20" 形式的约束
    const match = constraint.match(/>=\s*(\d+)/)
    if (!match) {
      return { name, status: 'DEGRADED', message: `无法解析 engines.node 约束: ${constraint}` }
    }

    const minMajor = parseInt(match[1], 10)
    if (major < minMajor) {
      return {
        name,
        status: 'DEGRADED',
        message: `当前 ${currentVersion}，要求 ${constraint}`
      }
    }

    return { name, status: 'OK', message: `${currentVersion} 满足 ${constraint}` }
  } catch (err) {
    return { name, status: 'DEGRADED', message: `检查失败: ${String(err)}` }
  }
}

function checkNativeModule(moduleName: string, displayName: string): CheckResult {
  const name = `${displayName} 原生绑定`
  try {
    require(moduleName)
    return { name, status: 'OK', message: `${moduleName} 加载成功` }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      name,
      status: 'DEGRADED',
      message: `${moduleName} 加载失败: ${errMsg.split('\n')[0]}`
    }
  }
}

function checkKoffiAndDll(): CheckResult {
  const name = 'koffi + nuan5_decryption.dll'
  try {
    // 1) 检查 koffi 是否可加载
    let koffiLoaded = false
    try {
      require('koffi')
      koffiLoaded = true
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        name,
        status: 'DEGRADED',
        message: `koffi 加载失败: ${errMsg.split('\n')[0]}`
      }
    }

    // 2) 检查 DLL 文件是否存在于 resources/ 目录
    const dllCandidates = [
      path.join(ROOT, 'resources', 'nuan5_decryption.dll'),
      // 打包后路径（asar unpack）
      path.join(ROOT, 'dist', 'main', 'resources', 'nuan5_decryption.dll')
    ]

    const found = dllCandidates.find((p) => fs.existsSync(p))
    if (!found) {
      return {
        name,
        status: 'DEGRADED',
        message: `nuan5_decryption.dll 未找到 (已检查: ${dllCandidates.map((p) => path.relative(ROOT, p)).join(', ')})`
      }
    }

    if (!koffiLoaded) {
      return { name, status: 'DEGRADED', message: 'koffi 不可用，无法加载 DLL' }
    }

    const relPath = path.relative(ROOT, found)
    return { name, status: 'OK', message: `koffi 可用，DLL 位于 ${relPath}` }
  } catch (err) {
    return { name, status: 'DEGRADED', message: `检查失败: ${String(err)}` }
  }
}

function checkDatabase(): CheckResult {
  const name = '数据库文件'
  const dbPath = path.join(ROOT, 'data', 'album_index.db')
  try {
    if (!fs.existsSync(dbPath)) {
      return {
        name,
        status: 'DEGRADED',
        message: `data/album_index.db 不存在（首次扫描后自动创建）`
      }
    }

    // 检查文件是否可读
    fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK)
    const stats = fs.statSync(dbPath)
    const sizeKB = (stats.size / 1024).toFixed(1)
    return { name, status: 'OK', message: `可读写，大小 ${sizeKB} KB` }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return { name, status: 'DEGRADED', message: `访问失败: ${errMsg}` }
  }
}

// ─── 主流程 ─────────────────────────────────────────────────

function main(): void {
  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkNativeModule('better-sqlite3', 'better-sqlite3'),
    checkNativeModule('sharp', 'sharp'),
    checkKoffiAndDll(),
    checkDatabase()
  ]

  // 输出标题
  console.log('')
  console.log('╔══════════════════════════════════════════╗')
  console.log('║        Meow Star Map 环境诊断报告        ║')
  console.log('╚══════════════════════════════════════════╝')
  console.log('')

  const hasDegraded = checks.some((c) => c.status === 'DEGRADED')

  for (const result of checks) {
    const icon = result.status === 'OK' ? '✓' : '✗'
    const statusTag =
      result.status === 'OK' ? `\x1b[32m${result.status}\x1b[0m` : `\x1b[33m${result.status}\x1b[0m`
    console.log(`  ${icon}  [${result.name}] ${statusTag}`)
    console.log(`     ${result.message}`)
    console.log('')
  }

  // 汇总
  const okCount = checks.filter((c) => c.status === 'OK').length
  const degradedCount = checks.filter((c) => c.status === 'DEGRADED').length
  const total = checks.length

  console.log('──────────────────────────────────────────')
  console.log(
    `  总计: ${total} 项  |  \x1b[32mOK: ${okCount}\x1b[0m  |  \x1b[33mDEGRADED: ${degradedCount}\x1b[0m`
  )
  console.log('──────────────────────────────────────────')

  if (hasDegraded) {
    console.log('')
    console.log('\x1b[33m⚠ 存在降级项，部分功能可能不可用。\x1b[0m')
    console.log('')
    process.exit(1)
  } else {
    console.log('')
    console.log('\x1b[32m✓ 所有检查通过，环境健康。\x1b[0m')
    console.log('')
    process.exit(0)
  }
}

main()
