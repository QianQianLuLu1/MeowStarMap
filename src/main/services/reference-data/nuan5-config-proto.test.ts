// @layer main/services
// @module nuan5-config-proto
// @coverage Nuan5Config protobuf wire 解码（手编字节流，不依赖编码侧 schema）
//
// 测试字节流按 protobuf wire format 手工构造（tag = field<<3|wireType），
// 不经 protobufjs 编码——避免「同一份 schema 编码再解码」的自证循环，
// 字段号正确性由与上游 rust/src/nuan5_database/model.rs 的逐字段转写共同钉住。
import { describe, it, expect } from 'vitest'
import { getNuan5ConfigType } from './nuan5-config-proto'

// ===== wire format 手编辅助 =====

function varint(value: number): number[] {
  const out: number[] = []
  let v = value
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}

function tag(fieldNumber: number, wireType: 0 | 1 | 2): number[] {
  return varint((fieldNumber << 3) | wireType)
}

function lenDelim(fieldNumber: number, payload: number[]): number[] {
  return [...tag(fieldNumber, 2), ...varint(payload.length), ...payload]
}

function stringField(fieldNumber: number, s: string): number[] {
  return lenDelim(fieldNumber, [...Buffer.from(s, 'utf8')])
}

function doubleField(fieldNumber: number, v: number): number[] {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(v)
  return [...tag(fieldNumber, 1), ...b]
}

function varintField(fieldNumber: number, value: number): number[] {
  return [...tag(fieldNumber, 0), ...varint(value)]
}

/** Nuan5WorldMapTileInfo：url_template=1(str) max_zoom=2 min_zoom=3 width=4 height=5 x=6 y=7 px_pre_unit=8 */
function mapTileInfoBytes(): number[] {
  return [
    ...stringField(1, 'https://tiles.example.test/{z}/{x}/{y}.png'),
    ...varintField(2, 5), // max_zoom
    ...varintField(3, 2), // min_zoom
    ...varintField(4, 4096), // map_width_of_max_zoom
    ...varintField(5, 4096), // map_height_of_max_zoom
    ...doubleField(6, 1024.5), // original_point_x
    ...doubleField(7, 512.25), // original_point_y
    ...doubleField(8, 3.5) // px_pre_unit
  ]
}

/** Nuan5NetworkImageItem：base_url=1(str) replace=2(str) */
function networkImageItemBytes(): number[] {
  return [...stringField(1, 'https://cdn.example.test/img/{id}.png'), ...stringField(2, '{id}')]
}

/** protobuf map entry：key=字段1(varint int32) + value=字段2(长度界定消息体) */
function mapEntry(key: number, valueBytes: number[]): number[] {
  return [...varintField(1, key), ...lenDelim(2, valueBytes)]
}

describe('getNuan5ConfigType decode', () => {
  it('world map（tag 26）+ map_tile_info 嵌套字段逐项命中', () => {
    const worldEntry = mapEntry(1, lenDelim(1, mapTileInfoBytes())) // value=Nuan5World{map_tile_info}
    const configBytes = Uint8Array.from(lenDelim(26, worldEntry))
    const decoded = getNuan5ConfigType().decode(configBytes) as {
      world?: Record<string, { mapTileInfo?: Record<string, unknown> | null }>
    }

    const world = decoded.world?.['1']
    expect(world).toBeDefined()
    const tile = world?.mapTileInfo
    expect(tile?.['urlTemplate']).toBe('https://tiles.example.test/{z}/{x}/{y}.png')
    expect(tile?.['maxZoom']).toBe(5)
    expect(tile?.['minZoom']).toBe(2)
    expect(tile?.['mapWidthOfMaxZoom']).toBe(4096)
    expect(tile?.['mapHeightOfMaxZoom']).toBe(4096)
    expect(tile?.['originalPointX']).toBeCloseTo(1024.5)
    expect(tile?.['originalPointY']).toBeCloseTo(512.25)
    expect(tile?.['pxPreUnit']).toBeCloseTo(3.5)
  })

  it('network_image（tag 20001）的高字段号条目命中（cloth=4）', () => {
    const networkImageBytes = lenDelim(4, networkImageItemBytes())
    const configBytes = Uint8Array.from(lenDelim(20001, networkImageBytes))
    const decoded = getNuan5ConfigType().decode(configBytes) as {
      networkImage?: Record<string, Record<string, string> | null>
    }
    expect(decoded.networkImage?.['cloth']).toEqual({
      baseUrl: 'https://cdn.example.test/img/{id}.png',
      replace: '{id}'
    })
  })

  it('未知字段（更高 tag）被容忍跳过，不破坏解码（上游结构前向兼容）', () => {
    const unknownField = varintField(999, 1)
    const worldEntry = mapEntry(1, lenDelim(1, mapTileInfoBytes()))
    const configBytes = Uint8Array.from([...unknownField, ...lenDelim(26, worldEntry)])
    const decoded = getNuan5ConfigType().decode(configBytes) as {
      world?: Record<string, unknown>
    }
    expect(decoded.world?.['1']).toBeDefined()
  })

  it('非法字节流（截断的长度前缀）→ decode 抛错（损坏数据不静默）', () => {
    // tag 26 + 声明长度 100 但只给 2 字节 payload
    const bad = Uint8Array.from([...tag(26, 2), 100, 0x0a, 0x02])
    expect(() => getNuan5ConfigType().decode(bad)).toThrow()
  })

  it('空输入：map 字段缺省为 {}，singular message 字段缺省为 null', () => {
    const decoded = getNuan5ConfigType().decode(Uint8Array.of()) as Record<string, unknown>
    expect(decoded.world).toEqual({})
    expect(decoded.networkImage).toBeNull()
  })
})
