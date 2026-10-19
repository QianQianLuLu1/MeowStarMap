import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CLI_LIMIT,
  formatRuntimeRunLines,
  isRuntimeRunErrorLine,
  parseRuntimeCliArgs,
  type RuntimeRunSummary
} from './runtime-cli-report'

/**
 * 内嵌 Runtime 验证入口的输出层单测（阶段 2）。
 * 与 `probe.test.ts` 同口径：文本形态在这里锁死，入口壳 `runtime-cli.ts` 不再产生逻辑。
 */

const BASE: RuntimeRunSummary = {
  ok: true,
  state: 'running',
  dbPath: '/tmp/nikkisync/nikkisync.db',
  linkReady: true,
  tables: 12
}

describe('parseRuntimeCliArgs', () => {
  it('正常：--k=v 逐项生效，缺省落在临时目录与保守 limit', () => {
    const parsed = parseRuntimeCliArgs(
      ['--game-root=H:\\game', '--limit=20', '--watcher=1', '--data-dir=/tmp/x'],
      '/tmp/default'
    )
    expect(parsed).toEqual({
      gameRoot: 'H:\\game',
      dataDir: '/tmp/x',
      limit: 20,
      watcher: true
    })
    expect(parseRuntimeCliArgs([], '/tmp/default')).toEqual({
      dataDir: '/tmp/default',
      limit: DEFAULT_CLI_LIMIT,
      watcher: false
    })
  })

  it('边界：未知键、空值、越界 limit 一律忽略并保持缺省（不静默改行为）', () => {
    const parsed = parseRuntimeCliArgs(
      ['--unknown=1', '--game-root=', '--limit=0', '--limit=99999', '--limit=abc', 'positional'],
      '/tmp/default'
    )
    expect(parsed.gameRoot).toBeUndefined()
    expect(parsed.limit).toBe(DEFAULT_CLI_LIMIT)
    expect(parsed.watcher).toBe(false)
  })
})

describe('formatRuntimeRunLines', () => {
  it('成功：四段式报告，缺 scan/query 时不虚构计数', () => {
    const lines = formatRuntimeRunLines(BASE)
    expect(lines).toEqual([
      '[nikkisync-runtime] state=running dbPath=/tmp/nikkisync/nikkisync.db linkReady=true tables=12',
      '[result  ] OK'
    ])
  })

  it('正常：带扫描与查询计数时输出 scan/query 两行', () => {
    const lines = formatRuntimeRunLines({
      ...BASE,
      filesObserved: 7,
      assetsCreated: 3,
      assets: 3,
      motionAssets: 1,
      firstAssetId: 'asset_abc'
    })
    expect(lines[1]).toBe('[scan    ] filesObserved=7 assetsCreated=3')
    expect(lines[2]).toBe('[query   ] assets=3 motionAssets=1 firstAssetId=asset_abc')
    expect(lines[3]).toBe('[result  ] OK')
  })

  it('失败：错误行进 [fail    ] 且收尾 FAILED，缺原因时给占位文本', () => {
    const lines = formatRuntimeRunLines({
      ...BASE,
      ok: false,
      state: 'degraded',
      error: 'no install'
    })
    expect(lines).toContain('[fail    ] no install')
    expect(lines).toContain('[result  ] FAILED')
    expect(formatRuntimeRunLines({ ...BASE, ok: false })).toContain('[fail    ] unknown failure')
  })

  it('isRuntimeRunErrorLine 只把 fail / FAILED 判为错误输出', () => {
    for (const line of formatRuntimeRunLines({ ...BASE, ok: false, error: 'x' })) {
      expect(isRuntimeRunErrorLine(line)).toBe(
        line.startsWith('[fail    ]') || line.startsWith('[result  ] FAILED')
      )
    }
    expect(isRuntimeRunErrorLine('[result  ] OK')).toBe(false)
  })
})
