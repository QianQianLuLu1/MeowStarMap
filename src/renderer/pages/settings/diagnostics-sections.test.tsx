/**
 * @vitest-environment jsdom
 *
 * diagnostics-sections.tsx 的 GPU 状态卡回归（文件名与源文件同 base，
 * 使 npm run verify / .husky/pre-commit 能自动把本文件绑到 diagnostics-sections.tsx）。
 *
 * 数据源 window.electronAPI.app.getGpuStatus()（app:gpu-status 只读探针）。
 * 覆盖：正常态全字段渲染 / 异常态（探针抛错）/ 边界（gpus·featureStatus 为 null、
 * 硬件加速关闭带原因、独显偏好跟随系统）。
 *
 * 运行：npx vitest run src/renderer/pages/settings/diagnostics-sections.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DiagnosticsGpuSection } from './diagnostics-sections'
import { GlobalToastContext } from './shared'

let getGpuStatus: ReturnType<typeof vi.fn>

function installElectronApi(status?: Promise<unknown>) {
  getGpuStatus = vi.fn(() => (status === undefined ? Promise.resolve(null) : status))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    app: { getGpuStatus }
  }
}

const mockShowMessage = vi.fn()

const FULL_STATUS = {
  hardwareAcceleration: { enabled: true, reason: 'default' },
  fallback: { active: false, consecutiveFailures: 0, fallbackVersion: null },
  discretePreference: { mode: 'high-performance', registry: 'set' },
  featureStatus: { canvas: 'enabled', webgl: 'enabled' },
  gpus: [
    {
      vendorId: '0x10de',
      deviceId: '0x2504',
      vendor: 'NVIDIA',
      device: 'NVIDIA GeForce RTX 3060',
      active: null
    },
    {
      vendorId: '0x8086',
      deviceId: '0x46a6',
      vendor: 'Intel',
      device: 'Intel Iris Xe',
      active: null
    }
  ],
  activeGpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)',
  electronVersion: '41.0.0',
  platform: 'win32'
}

beforeEach(() => {
  mockShowMessage.mockClear()
})

describe('DiagnosticsGpuSection — GPU 状态卡', () => {
  it('(正常) 全字段渲染：硬件加速开启/原因/活动显卡/显卡数/特性/回退/独显偏好', async () => {
    installElectronApi(Promise.resolve(FULL_STATUS))
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <DiagnosticsGpuSection />
      </GlobalToastContext.Provider>
    )
    await waitFor(() => expect(getGpuStatus).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        screen.getByText('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)')
      ).toBeInTheDocument()
    )
    // 硬件加速：已开启 + 默认开启（原因带括号渲染在子 span）
    expect(screen.getByText('已开启')).toBeInTheDocument()
    expect(screen.getByText('(默认开启)')).toBeInTheDocument()
    // 双显卡清单（活动显卡行与清单行都含该型号，用 getAllByText）
    expect(screen.getAllByText(/NVIDIA GeForce RTX 3060/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/Intel Iris Xe/)).toBeInTheDocument()
    // 特性状态原样透出
    expect(screen.getByText(/canvas:/)).toBeInTheDocument()
    expect(screen.getByText(/webgl:/)).toBeInTheDocument()
    // 回退未激活 + 独显偏好
    expect(screen.getByText('未激活')).toBeInTheDocument()
    expect(screen.getByText('高性能独显')).toBeInTheDocument()
  })

  it('(异常) getGpuStatus 抛错 → 显示读取失败提示，不白屏', async () => {
    installElectronApi(Promise.reject(new Error('probe failed')))
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <DiagnosticsGpuSection />
      </GlobalToastContext.Provider>
    )
    await waitFor(() => expect(screen.getByText('GPU 状态读取失败')).toBeInTheDocument())
  })

  it('(边界) gpus/featureStatus 为 null → 显示不可用；硬件加速关闭带原因', async () => {
    installElectronApi(
      Promise.resolve({
        ...FULL_STATUS,
        hardwareAcceleration: { enabled: false, reason: 'crash-fallback' },
        fallback: { active: true, consecutiveFailures: 2, fallbackVersion: '2.5.5' },
        discretePreference: { mode: 'auto', registry: null },
        featureStatus: null,
        gpus: null,
        activeGpu: null
      })
    )
    render(
      <GlobalToastContext.Provider value={mockShowMessage}>
        <DiagnosticsGpuSection />
      </GlobalToastContext.Provider>
    )
    await waitFor(() => expect(screen.getByText('已关闭')).toBeInTheDocument())
    expect(screen.getByText('(因崩溃自动回退)')).toBeInTheDocument()
    expect(screen.getByText(/已激活（v=2\.5\.5/)).toBeInTheDocument()
    expect(screen.getByText('跟随系统')).toBeInTheDocument()
    const unavailable = screen.getAllByText('不可用')
    expect(unavailable.length).toBeGreaterThanOrEqual(2) // 活动显卡 + 特性/清单
  })
})
