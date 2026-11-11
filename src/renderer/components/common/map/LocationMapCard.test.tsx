/**
 * @vitest-environment jsdom
 *
 * 审查修复（2026-11-11）：懒加载 chunk 失败必须由局部 ErrorBoundary（ZoneErrorFallback）
 * 兜底，只降级地图区域，不得升级到路由级边界整页降级。
 * 用「模块可加载但组件渲染即抛错」模拟 chunk 运行期失败（与 import 拒绝同走
 * ErrorBoundary 兜底路径；不用工厂抛错——vitest 会包装消息并截断，断言失真）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { LocationMapCard } from './LocationMapCard'
import type { MiralandMapView } from './MiralandMap'

vi.mock('./MiralandMap', () => ({
  MiralandMap: () => {
    throw new Error('chunk load failed')
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const VIEW = {
  tile: {
    worldId: 1,
    urlTemplate: 'https://assets.papegames.com/maps/tiles-1/{z}-{x}-{y}.webp',
    minZoom: 0,
    maxZoom: 3,
    mapWidthOfMaxZoom: 1024,
    mapHeightOfMaxZoom: 1024,
    originalPointX: 100,
    originalPointY: -50,
    pxPreUnit: 2
  },
  pixel: { px: 120, py: -40 },
  bounds: { width: 1024, height: 1024 },
  crsZoom: 3,
  outside: false
} as MiralandMapView

describe('LocationMapCard — chunk 失败局部降级（审查修复）', () => {
  it('懒加载失败 → ZoneErrorFallback 展示错误摘要，不向上冒泡', async () => {
    render(<LocationMapCard view={VIEW} />)
    expect(await screen.findByText('chunk load failed')).toBeInTheDocument()
    expect(screen.getByText('errorFallback.zoneTitle')).toBeInTheDocument()
  })
})
