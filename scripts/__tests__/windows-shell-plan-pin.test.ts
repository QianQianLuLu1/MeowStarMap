/**
 * N0 落档守卫：Windows-Shell 能力全量对齐计划必须先写入 docs/plans/ 才允许改业务代码。
 *
 * 红灯来源（落档前）：目标 MD 不存在，existsSync 为 false。
 * 该文件只做只读校验，不参与任何业务路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const planPath = path.join(
  projectRoot,
  'docs',
  'plans',
  '2026-11-13-nikkisync-windows-shell-full-align-实施计划.md'
)

const REQUIRED_SECTIONS = [
  '## 1. 依赖声明',
  '## 2. 启动说明',
  '## 3. 错误处理',
  '## 4. 参数校验',
  '## 5. 基础测试用例',
  '## 6. 逐节点实施',
  '## 7. 全量回归',
  '## 8. 剩余风险',
  '## 9. 最终输出模板'
] as const

describe('Windows-Shell 全量对齐计划落档', () => {
  it('计划 MD 已写入 docs/plans/', () => {
    expect(fs.existsSync(planPath)).toBe(true)
  })

  it.each(REQUIRED_SECTIONS)('计划包含必备章节 %s', (section) => {
    const content = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : ''
    expect(content).toContain(section)
  })

  it('计划钉住上游基准 a49764bb 与全量回归命令', () => {
    const content = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : ''
    expect(content).toContain('a49764bbf98fcb26a84f2356b78d48c459d3da2e')
    expect(content).toContain('npm test')
  })
})
