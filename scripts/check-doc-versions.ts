/**
 * 文档版本一致性校验脚本
 *
 * 解析 package.json 中声明的 Electron 版本范围（devDependencies 优先，回退 dependencies），
 * 取 major.minor 作为可比较的展示版本，校验 README.md 中所有 "Electron <version>" 字符串是否与之匹配。
 * 任一不匹配则以非零退出码阻止打包，并打印差异。
 *
 * 用法：npx tsx scripts/check-doc-versions.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

function majorMinor(range: string): string {
  const cleaned = range.replace(/^[\^~>=<\s]+/, '').split('.')
  return `${cleaned[0]}.${cleaned[1] ?? '0'}`
}

function main(): void {
  console.log('\n[check-doc-versions] 校验 README 中 Electron 版本与 package.json 一致\n')

  const pkgPath = path.join(ROOT, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    console.error('[check-doc-versions] ✖ 未找到 package.json')
    process.exit(1)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Pkg

  const range = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
  if (!range) {
    console.error(
      '[check-doc-versions] ✖ package.json 未声明 electron 依赖（dependencies / devDependencies）'
    )
    process.exit(1)
  }
  const expected = majorMinor(range)

  const readmePath = path.join(ROOT, 'README.md')
  if (!fs.existsSync(readmePath)) {
    // README 不存在（已从仓库移除）时，文档一致性校验无对象，跳过即可，不阻断打包。
    console.log(
      '[check-doc-versions] ⚠ 未找到 README.md，跳过 README 版本一致性校验（不影响打包）\n'
    )
    process.exit(0)
  }
  const readme = fs.readFileSync(readmePath, 'utf-8')

  const re = /Electron[ -](\d+\.\d+(?:\.\d+)?)/g
  const found = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(readme)) !== null) found.add(m[1])

  if (found.size === 0) {
    console.error('[check-doc-versions] ✖ README.md 中未找到任何 Electron 版本字符串')
    process.exit(1)
  }

  const mismatches = [...found].filter((v) => majorMinor(v) !== expected)
  if (mismatches.length > 0) {
    console.error('[check-doc-versions] ❌ README 中 Electron 版本与 package.json 不一致：')
    console.error(`  package.json electron: ${range}  (期望 major.minor = ${expected})`)
    console.error(`  README 中不匹配的版本: ${mismatches.join(', ')}`)
    console.error('  请同步修改 README.md 中的 Electron 版本（徽章与技术栈表格）。\n')
    process.exit(1)
  }

  console.log(
    `[check-doc-versions] ✅ README 中所有 Electron 版本均为 ${expected}，与 package.json (${range}) 一致。\n`
  )
  process.exit(0)
}

main()
