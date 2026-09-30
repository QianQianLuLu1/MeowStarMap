/**
 * @vitest-environment jsdom
 *
 * 分享家族图标几何守卫 + 字形指纹 — 防「分享图标显示不完全」回归测试。
 *
 * 历史：初版 IconShare 为「WiFi 弧线 + 圆点」手绘字形，首条弧线 `M12 3a17 17 0 0 1 12 5`
 * 终点落在 (24, 8)，恰好压在 viewBox="0 0 24 24" 右缘；strokeWidth=2 + 圆头描边延伸至
 * x≈24.7，被 svg 根元素默认 overflow:hidden 裁掉（外弧右端切平，表现为图标显示不完全）。
 * 2026-09-30 第一次修复将弧线终点收进 (23, 7.5)，但缩短后的弧线仍呈悬空截断观感，
 * 字形设计本身被否决。
 *
 * 现状：IconShare 已整体替换为 Lucide share-2（三节点网络，业界通用分享符号，
 * ISC License，坐标取自 lucide-static v1.49.0 icons/share-2.svg）。
 *
 * 守卫规则 1（几何）：所有 path 命令端点与基本图形（circle/polyline/line/rect）范围必须
 * 位于描边安全区 [0.5, 23.5]（预留 strokeWidth/2 = 1 的描边余量，再留 0.5 收敛差）。
 * 守卫规则 2（指纹）：IconShare 必须与 Lucide share-2 参考字形逐坐标一致，
 * 防止字形被改回存在视觉缺陷的旧设计。
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { FC, ReactElement } from 'react'
import { IconShare, IconWeChat, IconQQ, IconVivo } from './index'

/** 描边安全区边界：viewBox 24 × 24，内缩 1（strokeWidth/2）+ 0.5 收敛差 */
const SAFE_MIN = 0.5
const SAFE_MAX = 23.5

interface Endpoint {
  x: number
  y: number
}

/** 各路径命令单次重复的参数个数 */
const ARG_COUNT: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0
}

const isLetter = (token: string | undefined): boolean =>
  token !== undefined && /^[a-zA-Z]$/.test(token)

/** 按命令推进当前点，返回该次重复的终点 */
function step(cmd: string, relative: boolean, args: number[], cur: Endpoint): Endpoint {
  let { x, y } = cur
  switch (cmd) {
    case 'M':
    case 'L':
    case 'T':
      x = relative ? x + args[0] : args[0]
      y = relative ? y + args[1] : args[1]
      break
    case 'H':
      x = relative ? x + args[0] : args[0]
      break
    case 'V':
      y = relative ? y + args[0] : args[0]
      break
    case 'C':
      x = relative ? x + args[4] : args[4]
      y = relative ? y + args[5] : args[5]
      break
    case 'S':
    case 'Q':
      x = relative ? x + args[2] : args[2]
      y = relative ? y + args[3] : args[3]
      break
    case 'A':
      x = relative ? x + args[5] : args[5]
      y = relative ? y + args[6] : args[6]
      break
    default:
      throw new Error(`不支持的路径命令：${cmd}`)
  }
  return { x, y }
}

/**
 * 轻量 SVG path 端点扫描器：跟踪每条命令（含隐式重复参数组）的终点绝对坐标，
 * 不做弧线/曲线内部采样。遇到未知命令或参数不足时显式抛错，防止静默漏检。
 */
export function scanPathEndpoints(d: string): Endpoint[] {
  // 数字 token 先于字母匹配，避免科学计数法中的 e/E 被误判为命令字母
  const tokens = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[a-zA-Z]/g) ?? []
  const points: Endpoint[] = []
  let cur: Endpoint = { x: 0, y: 0 }
  let subpathStart: Endpoint = { x: 0, y: 0 }
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]
    if (!isLetter(token)) {
      throw new Error(`路径数据非法：期望命令字母，实际 "${token}"`)
    }
    const raw = token
    const cmd = raw.toUpperCase()
    const argCount = ARG_COUNT[cmd]
    if (argCount === undefined) {
      throw new Error(`不支持的路径命令：${raw}`)
    }
    i += 1
    if (cmd === 'Z') {
      // 闭合：回到子路径起点，该端点已随 M 记录，无需新增
      cur = { ...subpathStart }
      continue
    }
    // 同一命令的隐式重复参数组（如 c 后跟 12 个数字 = 两组）
    while (i < tokens.length && !isLetter(tokens[i])) {
      const args: number[] = []
      for (let k = 0; k < argCount; k++) {
        if (i >= tokens.length || isLetter(tokens[i])) {
          throw new Error(`路径命令 ${raw} 参数不足：需要 ${argCount} 个`)
        }
        args.push(Number(tokens[i]))
        i += 1
      }
      cur = step(cmd, raw !== cmd, args, cur)
      if (cmd === 'M') subpathStart = { ...cur }
      points.push({ ...cur })
    }
  }
  return points
}

const inSafeArea = (x: number, y: number): boolean =>
  x >= SAFE_MIN && x <= SAFE_MAX && y >= SAFE_MIN && y <= SAFE_MAX

/** 渲染图标并返回 svg 元素 */
function renderIcon(icon: ReactElement): SVGSVGElement {
  const { container } = render(icon)
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('图标未渲染出 svg 元素')
  return svg
}

/** 汇总单个 svg 内所有基本图形的越界描述 */
function collectViolations(svg: SVGSVGElement): string[] {
  const violations: string[] = []
  svg.querySelectorAll('path').forEach((p) => {
    const d = p.getAttribute('d')
    if (!d) throw new Error('path 缺少 d 属性')
    for (const pt of scanPathEndpoints(d)) {
      if (!inSafeArea(pt.x, pt.y)) {
        violations.push(`path 端点 (${pt.x}, ${pt.y}) 越界，d="${d}"`)
      }
    }
  })
  svg.querySelectorAll('circle').forEach((c) => {
    const cx = Number(c.getAttribute('cx'))
    const cy = Number(c.getAttribute('cy'))
    const r = Number(c.getAttribute('r'))
    if (
      !inSafeArea(cx - r, cy - r) ||
      !inSafeArea(cx + r, cy + r) ||
      !inSafeArea(cx - r, cy + r) ||
      !inSafeArea(cx + r, cy - r)
    ) {
      violations.push(`circle 范围越界，cx=${cx} cy=${cy} r=${r}`)
    }
  })
  svg.querySelectorAll('polyline').forEach((pl) => {
    const nums = (pl.getAttribute('points') ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    for (let k = 0; k + 1 < nums.length; k += 2) {
      if (!inSafeArea(nums[k], nums[k + 1])) {
        violations.push(`polyline 端点 (${nums[k]}, ${nums[k + 1]}) 越界`)
      }
    }
  })
  svg.querySelectorAll('line').forEach((ln) => {
    const coords = ['x1', 'y1', 'x2', 'y2'].map((attr) => Number(ln.getAttribute(attr)))
    for (let k = 0; k < coords.length; k += 2) {
      if (!inSafeArea(coords[k], coords[k + 1])) {
        violations.push(`line 端点 (${coords[k]}, ${coords[k + 1]}) 越界`)
      }
    }
  })
  svg.querySelectorAll('rect').forEach((rc) => {
    const x = Number(rc.getAttribute('x'))
    const y = Number(rc.getAttribute('y'))
    const w = Number(rc.getAttribute('width'))
    const h = Number(rc.getAttribute('height'))
    if (!inSafeArea(x, y) || !inSafeArea(x + w, y + h)) {
      violations.push(`rect 范围越界，x=${x} y=${y} w=${w} h=${h}`)
    }
  })
  return violations
}

const SHARE_FAMILY: Array<[string, FC<{ size?: number }>]> = [
  ['IconShare', IconShare],
  ['IconWeChat', IconWeChat],
  ['IconQQ', IconQQ],
  ['IconVivo', IconVivo]
]

describe('分享家族图标 — viewBox 几何守卫（防截断）', () => {
  it.each(SHARE_FAMILY)('%s 所有基本图形位于描边安全区 [0.5, 23.5]', (_name, Icon) => {
    const svg = renderIcon(<Icon size={16} />)
    expect(collectViolations(svg)).toEqual([])
  })
})

describe('IconShare — Lucide share-2 字形指纹（防回退到缺陷设计）', () => {
  it('IconShare 渲染 3 个 circle 与 2 个 line（无 path/弧线）', () => {
    const svg = renderIcon(<IconShare size={16} />)
    expect(svg.querySelectorAll('circle').length).toBe(3)
    expect(svg.querySelectorAll('line').length).toBe(2)
    expect(svg.querySelectorAll('path').length).toBe(0)
  })

  it('IconShare 字形与 Lucide share-2 参考字形逐坐标一致', () => {
    // 参考来源：lucide-static v1.49.0 icons/share-2.svg（ISC License）
    // https://github.com/lucide-icons/lucide
    const REFERENCE = {
      circles: [
        { cx: 18, cy: 5, r: 3 },
        { cx: 6, cy: 12, r: 3 },
        { cx: 18, cy: 19, r: 3 }
      ],
      lines: [
        { x1: 8.59, y1: 13.51, x2: 15.42, y2: 17.49 },
        { x1: 15.41, y1: 6.51, x2: 8.59, y2: 10.49 }
      ]
    }
    const svg = renderIcon(<IconShare size={16} />)
    const circles = Array.from(svg.querySelectorAll('circle')).map((c) => ({
      cx: Number(c.getAttribute('cx')),
      cy: Number(c.getAttribute('cy')),
      r: Number(c.getAttribute('r'))
    }))
    const lines = Array.from(svg.querySelectorAll('line')).map((l) => ({
      x1: Number(l.getAttribute('x1')),
      y1: Number(l.getAttribute('y1')),
      x2: Number(l.getAttribute('x2')),
      y2: Number(l.getAttribute('y2'))
    }))
    expect(circles).toEqual(REFERENCE.circles)
    expect(lines).toEqual(REFERENCE.lines)
  })
})

describe('分享家族图标 — 正常渲染（比例与关键属性）', () => {
  it.each([14, 16, 28])('size=%d 时四个图标均为方形 svg 且描边属性正确', (size) => {
    for (const [, Icon] of SHARE_FAMILY) {
      const svg = renderIcon(<Icon size={size} />)
      expect(svg.getAttribute('width')).toBe(String(size))
      expect(svg.getAttribute('height')).toBe(String(size))
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
      expect(svg.getAttribute('stroke-width')).toBe('2')
      expect(svg.getAttribute('stroke-linecap')).toBe('round')
    }
  })
})

describe('path 端点扫描器 — 异常状态', () => {
  it('遇到未支持的路径命令时显式抛错（防静默漏检）', () => {
    expect(() => scanPathEndpoints('M1 2X3 4')).toThrow(/不支持的路径命令/)
  })

  it('命令参数不足时显式抛错', () => {
    expect(() => scanPathEndpoints('M1')).toThrow(/参数不足/)
  })
})
