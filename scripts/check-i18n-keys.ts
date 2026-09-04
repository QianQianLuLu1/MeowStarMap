/**
 * i18n key 对齐校验脚本
 * 对比所有 locale 文件与 zh-CN.json 的 key 差异，CI 中强制校验
 * 用法：npx tsx scripts/check-i18n-keys.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

// ESM 环境下 __dirname 不存在，需从 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LOCALES_DIR = path.join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales')
const BASELINE = 'zh-CN.json'

function flattenKeys(obj: unknown, prefix = ''): string[] {
  const keys: string[] = []
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const fullKey = prefix ? `${prefix}.${k}` : k
      keys.push(fullKey)
      keys.push(...flattenKeys(v, fullKey))
    }
  }
  return keys
}

function loadKeys(filename: string): Set<string> {
  const content = fs.readFileSync(path.join(LOCALES_DIR, filename), 'utf-8')
  const json = JSON.parse(content)
  return new Set(flattenKeys(json))
}

function main(): void {
  const baselineKeys = loadKeys(BASELINE)
  const localeFiles = fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json') && f !== BASELINE)

  let hasError = false
  for (const file of localeFiles) {
    const fileKeys = loadKeys(file)
    const missing = [...baselineKeys].filter((k) => !fileKeys.has(k))
    const extra = [...fileKeys].filter((k) => !baselineKeys.has(k))

    if (missing.length > 0 || extra.length > 0) {
      hasError = true
      console.error(`\n[${file}] key 对齐失败：`)
      if (missing.length > 0) {
        console.error(`  缺失 ${missing.length} 个 key：`)
        missing.forEach((k) => console.error(`    - ${k}`))
      }
      if (extra.length > 0) {
        console.error(`  多余 ${extra.length} 个 key：`)
        extra.forEach((k) => console.error(`    - ${k}`))
      }
    } else {
      console.log(`[${file}] key 对齐成功 (${fileKeys.size} keys)`)
    }
  }

  if (hasError) {
    console.error('\n❌ i18n key 对齐校验失败，请补齐缺失的 key')
    process.exit(1)
  } else {
    console.log('\n✅ 所有 locale 文件 key 对齐校验通过')
  }
}

main()
