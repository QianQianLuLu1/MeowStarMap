import { describe, expect, it } from 'vitest'
import { parseArgs } from '../sync-e2e/launch-args'

/**
 * sync-e2e 启动器参数解析纯函数测试（scripts/AGENTS.md：核心逻辑导出供单测）。
 * 覆盖正常路径 / 异常路径 / 边界条件三类。
 */

describe('sync-e2e launch-args parseArgs', () => {
  it('returns defaults for empty argv', () => {
    expect(parseArgs([])).toEqual({
      host: '127.0.0.1',
      port: 0,
      pairHost: null,
      dataDir: null,
      qr: false
    })
  })

  it('parses all supported flags', () => {
    expect(
      parseArgs([
        '--host',
        '0.0.0.0',
        '--port',
        '27124',
        '--pair-host',
        '10.0.2.2',
        '--data-dir',
        'D:/tmp/e2e',
        '--qr'
      ])
    ).toEqual({
      host: '0.0.0.0',
      port: 27124,
      pairHost: '10.0.2.2',
      dataDir: 'D:/tmp/e2e',
      qr: true
    })
  })

  it('accepts --serve as a documented no-op（常驻即默认行为）', () => {
    expect(parseArgs(['--serve', '--qr'])).toEqual({
      host: '127.0.0.1',
      port: 0,
      pairHost: null,
      dataDir: null,
      qr: true
    })
  })

  it('rejects unknown arguments instead of silently ignoring typos', () => {
    expect(() => parseArgs(['--prot', '27124'])).toThrow(/unknown argument/i)
  })

  it.each(['abc', '-1', '65536', '1.5'])('rejects invalid --port %s', (port) => {
    expect(() => parseArgs(['--port', port])).toThrow(/--port/)
  })

  it('accepts boundary ports 0 and 65535', () => {
    expect(parseArgs(['--port', '0']).port).toBe(0)
    expect(parseArgs(['--port', '65535']).port).toBe(65535)
  })

  it('falls back to defaults when a flag value is missing', () => {
    // 与原实现语义一致：flag 位于末尾（无下一个 token）时回落默认值
    expect(parseArgs(['--host']).host).toBe('127.0.0.1')
    expect(parseArgs(['--port']).port).toBe(0)
    expect(parseArgs(['--pair-host']).pairHost).toBeNull()
    expect(parseArgs(['--data-dir']).dataDir).toBeNull()
  })
})
