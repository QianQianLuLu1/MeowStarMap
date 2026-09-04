import { describe, expect, it } from 'vitest'
import {
  mergeArrayRecords,
  mergeEditData,
  mergeEvoData,
  mergePearpalData,
  mergePullData
} from './merge'
import type { EvoRecord, PearpalTrackerItem, PullRecord } from './types'

const rec = (v: [string, string][]): PullRecord[] => v
const vrec = (v: [string, number][]): EvoRecord[] => v

describe('mergePullData', () => {
  it('空集：目标为空时直接采纳新数据', () => {
    const result = mergePullData({}, { 2: rec([['2025-01-01 10:00:00', '1020100001']]) })
    expect(result[2]).toEqual([['2025-01-01 10:00:00', '1020100001']])
  })
  it('全重复：全部跳过', () => {
    const existing = { 2: rec([['2025-01-01 10:00:00', '1020100001']]) }
    const result = mergePullData(existing, { 2: rec([['2025-01-01 10:00:00', '1020100001']]) })
    expect(result[2]).toHaveLength(1)
  })
  it('部分重叠：仅插入新时间戳', () => {
    const existing = {
      2: rec([
        ['2025-01-02 10:00:00', '1020100002'],
        ['2025-01-01 10:00:00', '1020100001']
      ])
    }
    const result = mergePullData(existing, {
      2: [
        ['2025-01-03 10:00:00', '1020100003'],
        ['2025-01-01 10:00:00', '1020100001']
      ]
    })
    expect(result[2]).toHaveLength(3)
    expect(result[2]![0]).toEqual(['2025-01-03 10:00:00', '1020100003'])
  })
  it('乱序新数据：新于最新则前插，旧于最旧则尾插，保持 newest-first', () => {
    const existing = { 2: rec([['2025-01-02 10:00:00', '1020100002']]) }
    const result = mergePullData(existing, {
      2: [
        ['2025-01-01 10:00:00', '1020100001'],
        ['2025-01-05 10:00:00', '1020100005']
      ]
    })
    expect(result[2]).toEqual([
      ['2025-01-05 10:00:00', '1020100005'],
      ['2025-01-02 10:00:00', '1020100002'],
      ['2025-01-01 10:00:00', '1020100001']
    ])
  })
  it('中间时间段（介于最新与最旧之间）按源语义不插入、仅去重', () => {
    const existing = {
      2: rec([
        ['2025-01-05 10:00:00', '1020100005'],
        ['2025-01-01 10:00:00', '1020100001']
      ])
    }
    const result = mergePullData(existing, { 2: [['2025-01-03 10:00:00', '1020100003']] })
    expect(result[2]).toHaveLength(2)
  })
  it('不同卡池互不影响', () => {
    const existing = { 2: rec([['2025-01-01 10:00:00', '1020100001']]) }
    const result = mergePullData(existing, { 3: [['2025-01-01 10:00:00', '1020200001']] })
    expect(result[2]).toHaveLength(1)
    expect(result[3]).toHaveLength(1)
  })
})

describe('mergeEditData', () => {
  it('以 itemId 为幂等键去重', () => {
    const existing = { 2: rec([['2025-01-01 10:00:00', '1020100001']]) }
    const result = mergeEditData(existing, {
      2: [
        ['2025-01-02 10:00:00', '1020100001'],
        ['2025-01-03 10:00:00', '1020100003']
      ]
    })
    expect(result[2]).toHaveLength(2)
    expect(result[2]!.some((e) => e[1] === '1020100003')).toBe(true)
  })
  it('空集合并', () => {
    expect(mergeEditData({}, {})).toEqual({})
  })
})

describe('mergeEvoData', () => {
  it('upload 模式本地覆盖远端', () => {
    const local = { 2: vrec([['10001', 3]]) }
    const remote = { 2: vrec([['10001', 1]]), 3: vrec([['10002', 1]]) }
    expect(mergeEvoData(local, remote, 'upload')).toEqual({
      2: [['10001', 3]],
      3: [['10002', 1]]
    })
  })
  it('download 模式远端覆盖本地', () => {
    const local = { 2: vrec([['10001', 3]]) }
    const remote = { 2: vrec([['10001', 1]]) }
    expect(mergeEvoData(local, remote, 'download')).toEqual({ 2: [['10001', 1]] })
  })
})

describe('mergePearpalData / mergeArrayRecords', () => {
  const item = (poolCnt: number, result: string): PearpalTrackerItem => ({
    card_pool_id: '2',
    pool_cnt: poolCnt,
    result,
    times_from_last_five_stars: 0,
    times_from_last_four_stars: 0,
    rarity: '5'
  })
  it('逐行 JSON 键去重', () => {
    const local = { 2: [item(1, '1020100001')] }
    const remote = { 2: [item(1, '1020100001'), item(2, '1020100002')] }
    const merged = mergePearpalData(local, remote)
    expect(merged[2]).toHaveLength(2)
  })
  it('乱序与空集', () => {
    expect(mergeArrayRecords(undefined, { 2: [1, 2] }, String)).toEqual({ 2: [1, 2] })
    expect(mergeArrayRecords({ 2: [1] }, undefined, String)).toEqual({ 2: [1] })
  })
})
