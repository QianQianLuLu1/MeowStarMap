/**
 * @layer L1
 * @module src/main/scanner/integrity-root-filter
 * @coverage buildIntegrityRootFilter / escapeLikePattern
 * @dependencies path
 * @remarks 纯函数测试（无 DB/外部依赖），覆盖转义与三种 roots 分支
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import {
  buildIntegrityRootFilter,
  escapeLikePattern,
  normalizeRootPrefixForLike,
  ROOT_LIKE_CLAUSE
} from './integrity-root-filter'

describe('escapeLikePattern', () => {
  it('反斜杠被转义', () => {
    expect(escapeLikePattern('C:\\foo')).toBe('C:\\\\foo')
  })

  it('% 与 _ 被转义', () => {
    expect(escapeLikePattern('a%b_c')).toBe('a\\%b\\_c')
  })

  it('混合特殊字符全部转义', () => {
    expect(escapeLikePattern('C:\\a%b_c')).toBe('C:\\\\a\\%b\\_c')
  })

  it('普通字符不改动', () => {
    expect(escapeLikePattern('Photo123')).toBe('Photo123')
  })
})

describe('buildIntegrityRootFilter', () => {
  it('undefined → null（全库校验旧语义回退）', () => {
    expect(buildIntegrityRootFilter(undefined)).toBeNull()
  })

  it('空数组 → 0=1（无根可校验，直接跳过）', () => {
    const f = buildIntegrityRootFilter([])
    expect(f).not.toBeNull()
    expect(f!.clause).toBe('0=1')
    expect(f!.params).toEqual([])
  })

  it('单根 → 单个大小写不敏感 LIKE 前缀，参数锚定 path.sep', () => {
    const f = buildIntegrityRootFilter(['C:\\game\\ScreenShot'])
    expect(f!.clause).toBe(ROOT_LIKE_CLAUSE)
    expect(f!.params).toHaveLength(1)
    // 参数归一为小写正斜杠前缀（与 ROOT_LIKE_CLAUSE 的 LOWER(REPLACE(file_path,...)) 同口径）
    expect(f!.params[0]).toBe(normalizeRootPrefixForLike('C:\\game\\ScreenShot', path.sep))
    expect(f!.params[0]).toBe('c:/game/screenshot/%')
    // 前缀锚定分隔符，避免 c:/foo 误中 c:/foobar
    expect(f!.params[0]).toContain('/')
  })

  it('多根 → OR 拼接，参数数量与根一致', () => {
    const f = buildIntegrityRootFilter(['D:\\a', 'E:\\b'])
    expect(f!.clause).toBe(`${ROOT_LIKE_CLAUSE} OR ${ROOT_LIKE_CLAUSE}`)
    expect(f!.params).toHaveLength(2)
    expect(f!.params[0]).toBe(normalizeRootPrefixForLike('D:\\a', path.sep))
    expect(f!.params[1]).toBe(normalizeRootPrefixForLike('E:\\b', path.sep))
  })

  it('根路径含 % / _ 时仍正确转义，不产生额外占位符', () => {
    const f = buildIntegrityRootFilter(['C:\\my%album_pics'])
    expect(f!.clause).toBe(ROOT_LIKE_CLAUSE)
    expect(f!.params[0]).toBe(normalizeRootPrefixForLike('C:\\my%album_pics', path.sep))
    // % 与 _ 经 escapeLikePattern 转义为 \% 与 \_，再追加尾缀 %
    expect(f!.params[0]).toBe('c:/my\\%album\\_pics/%')
    // escapeLikePattern 已在 normalizeRootPrefixForLike 内部转义 %，不产生额外占位符
    const occurrences = (f!.clause.match(/\?/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('大小写不敏感：根含大写/CJK 与已存 file_path 大小写不一致时仍命中（防漏匹配）', () => {
    // root 用混合大小写，归一后变小写正斜杠；与存储的小写 file_path 一致，
    // 证明 Windows 路径盘符/目录大小写差异不会导致整棵子树被跳过 is_missing 校验。
    const f = buildIntegrityRootFilter(['C:\\Game\\ScreenShot'])
    expect(f!.params[0]).toBe('c:/game/screenshot/%')
    // 与同口径源 existingFiles 复用同一归一化函数，保证两侧范式完全对称
    expect(f!.params[0]).toBe(normalizeRootPrefixForLike('C:\\Game\\ScreenShot', path.sep))
  })
})
