// @core-change: 收敛图片类别为 shared 单一真相源，消除跨进程手写清单
/**
 * 图片类别「单一真相源」回归（src/shared/AGENTS.md：禁止任一侧复制同名类型）。
 *
 * 收敛前 NETWORK_IMAGE_KINDS 有两份手写清单（nuan5-config-proto.ts 的运行时数组、
 * electron-api.ts 的手写联合）加 handler 测试里第三份 10 类清单，新增类别时极易漏改。
 * 本文件同时做源码级漂移断言与运行时一致性断言，把「只有一处定义」钉成硬约束。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NETWORK_IMAGE_KINDS,
  isNetworkImageTemplateKind
} from '../../../shared/network-image-kinds'
import { NETWORK_IMAGE_KINDS as PROTO_KINDS } from './nuan5-config-proto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const readSrc = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('图片类别单一真相源', () => {
  it('electron-api.ts 不再手写类别联合，改为从 shared 派生', () => {
    const src = readSrc('src/shared/types/electron-api.ts')
    expect(src).not.toMatch(/export type NetworkImageTemplateKind\s*=\s*\n?\s*\|/)
    expect(src).toContain("from '../network-image-kinds'")
  })

  it('nuan5-config-proto.ts 不再重复定义类别数组，改为 re-export', () => {
    const src = readSrc('src/main/services/reference-data/nuan5-config-proto.ts')
    expect(src).not.toMatch(/export const NETWORK_IMAGE_KINDS\s*=\s*\[/)
    expect(src).toContain('shared/network-image-kinds')
  })

  it('handler 测试不再手抄 10 类清单', () => {
    const src = readSrc('src/main/ipc/handlers/reference-data-handler.test.ts')
    expect(src).toContain('NETWORK_IMAGE_KINDS')
    expect(src).not.toContain("'clothOutfit',")
  })

  it('shared 常量与 proto 的 re-export 是同一份引用，且恰为 10 类无重复', () => {
    expect(PROTO_KINDS).toBe(NETWORK_IMAGE_KINDS)
    expect(NETWORK_IMAGE_KINDS).toHaveLength(10)
    expect(new Set(NETWORK_IMAGE_KINDS).size).toBe(NETWORK_IMAGE_KINDS.length)
  })

  it('类型守卫：10 类全为 true', () => {
    for (const kind of NETWORK_IMAGE_KINDS) expect(isNetworkImageTemplateKind(kind)).toBe(true)
  })

  it.each([
    ['未知字符串', 'notAKind'],
    ['空串', ''],
    ['子域伪装式拼写', 'momopose'],
    ['null', null],
    ['undefined', undefined],
    ['数字', 1],
    ['对象', { kind: 'light' }]
  ])('异常/边界：%s 一律 fail-closed 返回 false', (_label, value) => {
    expect(isNetworkImageTemplateKind(value)).toBe(false)
  })
})
