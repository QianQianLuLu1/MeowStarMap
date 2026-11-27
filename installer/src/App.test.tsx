import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const mocks = vi.hoisted(() => ({
  closeInstaller: vi.fn(),
  detectState: vi.fn(),
  startInstall: vi.fn()
}))

vi.mock('./api', () => mocks)
vi.mock('./steps/ProgressStep', () => ({ default: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.detectState.mockResolvedValue({
    installed: false,
    version: null,
    installDir: null,
    appRunning: false,
    mode: 'install',
    payloadPath: 'payload.zip',
    defaultInstallDir: 'C:\\Apps\\MeowStarMap',
    silent: false
  })
})

describe('App', () => {
  it('已安装的 Unicode 自定义目录必须被保留，不得回落到默认目录', async () => {
    mocks.detectState.mockResolvedValue({
      installed: true,
      version: '2.5.7',
      installDir: 'C:\\用户\\喵星图',
      appRunning: false,
      mode: 'upgrade',
      payloadPath: 'payload.zip',
      defaultInstallDir: 'C:\\Apps\\MeowStarMap',
      silent: false
    })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))

    expect(await screen.findByDisplayValue('C:\\用户\\喵星图')).toBeInTheDocument()
  })

  it('提交点后的失败不得再声称已回滚到安装前状态', async () => {
    mocks.startInstall.mockRejectedValue(new Error('写入注册表失败'))
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))
    await screen.findByDisplayValue('C:\\Apps\\MeowStarMap')
    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))

    await screen.findByText(/写入注册表失败/)
    expect(screen.queryByText(/已回滚到安装前状态/)).not.toBeInTheDocument()
  })
})
