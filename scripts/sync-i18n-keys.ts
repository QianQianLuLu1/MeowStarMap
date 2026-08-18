/**
 * i18n key 同步脚本：以 zh-CN.json 为基线，将缺失的 key 用空字符串补齐到其他 locale 文件
 * 多余的 key 会被删除
 * 用法：npx tsx scripts/sync-i18n-keys.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

// ESM 环境下 __dirname 不存在，需从 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LOCALES_DIR = path.join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales')
const BASELINE = 'zh-CN.json'

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (current[part] === undefined || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

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

function syncFile(baseline: Record<string, unknown>, filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8')
  const target = JSON.parse(content) as Record<string, unknown>
  const baselineKeyList = flattenKeys(baseline)
  const targetKeyList = flattenKeys(target)
  const baselineSet = new Set(baselineKeyList)
  const targetSet = new Set(targetKeyList)

  // 补齐缺失的 key（递归构建结构）
  const missing: string[] = []
  for (const key of baselineKeyList) {
    if (!targetSet.has(key)) {
      // 仅当此 key 为叶子节点时才补齐（避免补齐中间节点导致结构错乱）
      const value = getNestedValue(baseline, key)
      if (value === undefined) continue
      // 只补齐字符串类型叶子值，对中间对象节点跳过
      if (typeof value === 'object' && value !== null) continue
      setNestedValue(target, key, '')
      missing.push(key)
    }
  }

  // 删除多余的 key
  const extra: string[] = []
  for (const key of targetKeyList) {
    if (!baselineSet.has(key)) {
      // 仅删除叶子节点
      const value = getNestedValue(target, key)
      if (value === undefined) continue
      if (typeof value === 'object' && value !== null) continue
      const parts = key.split('.')
      let current = target
      for (let i = 0; i < parts.length - 1; i++) {
        current = current[parts[i]] as Record<string, unknown>
        if (!current) break
      }
      if (current) delete current[parts[parts.length - 1]]
      extra.push(key)
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(target, null, 2) + '\n', 'utf-8')
  console.log(`[sync] ${path.basename(filePath)}: +${missing.length} / -${extra.length}`)
}

function main(): void {
  const baselinePath = path.join(LOCALES_DIR, BASELINE)
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as Record<string, unknown>

  const localeFiles = fs
    .readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json') && f !== BASELINE)

  for (const file of localeFiles) {
    syncFile(baseline, path.join(LOCALES_DIR, file))
  }

  console.log('\n✅ 同步完成，请运行 npm run i18n:check 验证')
}

main()
