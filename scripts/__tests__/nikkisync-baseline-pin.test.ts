/**
 * N0 基准钉子：把「同步图库装载的上游源码/编译产物」锁在 a49764bb（v1.0.40-public-beta.2）。
 *
 * 为什么存在：本仓通过 junction 消费工作区外 NikkiSync 克隆的 dist/，而 dist/ 未入库、
 * GalleryRuntime.mjs 是生成物。只推进源码或只跑一半构建都不会被既有测试发现。
 * 未链接/无克隆是受支持的默认态（CI npm ci 不带 junction），此时整件 skip。
 *
 * 红灯来源（推进前）：克隆停在 4cb71e2，且 4 个新 metadata 产物不存在。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveNikkiSyncRoot, toRootCandidates } from '../link-nikkisync'

const EXPECTED_HEAD = 'a49764bbf98fcb26a84f2356b78d48c459d3da2e'
const OLD_GALLERY_RUNTIME_BYTES = 277961

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const isDirectory = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}
const upRoot = resolveNikkiSyncRoot(
  toRootCandidates({ projectRoot, envRoot: process.env.NIKKISYNC_ROOT }),
  isDirectory
).root

const pcDist = (up: string, ...segments: string[]): string =>
  path.join(up, 'apps', 'pc-companion', 'dist', 'src', ...segments)

const NEW_METADATA_ARTIFACTS = [
  'LocalClothingIconPack.js',
  'LocalPhotoMetadataResolver.js',
  'MetadataInputFingerprint.js',
  'VerifiedPhotographyNames.js'
] as const

/**
 * 克隆根必须经 options.cwd 下传，不能塞进 `-C` 参数：ci-linux 装置的
 * child_process 轴按设计只翻译 program 与 options.cwd（args 数组不是路径），
 * 用 -C 会把 posix 假路径直接交给 git，静默返回空串并误报基准不符。
 * 与 scripts/check-md-links.ts:351 的既有调用形态一致。
 */
const readHeadSha = (up: string): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: up,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch (error) {
    console.warn(`[baseline-pin] git rev-parse HEAD failed for ${up}: ${String(error)}`)
    return ''
  }
}

describe.skipIf(upRoot === undefined)('NikkiSync 基准 a49764bb（链接态）', () => {
  const up = upRoot as string

  it('克隆 HEAD 恰好等于 v1.0.40-public-beta.2 的提交', () => {
    expect(readHeadSha(up)).toBe(EXPECTED_HEAD)
  })

  it.each(NEW_METADATA_ARTIFACTS)('新增 metadata 深入口产物 %s 已由完整 build 产出', (name) => {
    expect(fs.existsSync(pcDist(up, 'metadata', name))).toBe(true)
  })

  it('GalleryRuntime.mjs 已由 build-wechat-runtime.mjs 重新生成', () => {
    const file = pcDist(up, 'wechat', 'GalleryRuntime.mjs')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).size).toBeGreaterThan(OLD_GALLERY_RUNTIME_BYTES)
  })

  it('初始迁移含 2 张 nuan5 表与 resolver 指纹索引，且版本号未变', () => {
    const sql = fs.readFileSync(
      path.join(up, 'packages', 'database', 'migrations', '0001_initial.sql'),
      'utf8'
    )
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS nuan5_resolution')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS nuan5_endpoint_state')
    expect(sql).toContain('idx_assets_resolver_fingerprint')
    expect(sql).toContain("'initial_asset_resource_sync_schema'")
  })

  it('上游滤镜补充包 manifest 的 21 条 effectEntries 在位', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(up, 'assets', 'photo-filter-icons', 'manifest.json'), 'utf8')
    ) as { schemaVersion?: number; imageFormat?: string; effectEntries?: unknown[] }
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.imageFormat).toBe('webp')
    expect(manifest.effectEntries).toHaveLength(21)
  })
})
