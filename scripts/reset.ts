/**
 * 全量清理构建产物与缓存（幂等，目标不存在时不报错）
 *
 * 覆盖范围：
 *   1. dist/
 *   2. node_modules/.cache/（含 vitest 缓存）
 *   3. .vite/
 *   4. tsconfig.tsbuildinfo
 */
import { rmSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const dirs: Array<{ path: string; label: string }> = [
  { path: join(root, 'dist'), label: 'dist/' },
  { path: join(root, 'node_modules', '.cache'), label: 'node_modules/.cache/' },
  { path: join(root, '.vite'), label: '.vite/' }
]

const files: Array<{ path: string; label: string }> = [
  { path: join(root, 'tsconfig.tsbuildinfo'), label: 'tsconfig.tsbuildinfo' }
]

// 清理目录
for (const { path, label } of dirs) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true })
    console.log(`[reset] removed ${label}`)
  } else {
    console.log(`[reset] skip (not found) ${label}`)
  }
}

// 清理文件
for (const { path, label } of files) {
  if (existsSync(path)) {
    rmSync(path, { force: true })
    console.log(`[reset] removed ${label}`)
  } else {
    console.log(`[reset] skip (not found) ${label}`)
  }
}

console.log('[reset] done')
