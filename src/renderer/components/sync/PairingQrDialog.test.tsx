/**
 * @vitest-environment jsdom
 *
 * PairingQrDialog（配对二维码对话框）单元测试——阶段5 落地，阶段3 改接真实 NikkiSync 服务：
 *  (a) 打开时拉取 nikkisync.getPairingCode 并渲染出 QR SVG（qrcode 本地生成，无网络请求）
 *  (b) 渲染服务地址与有效期倒计时
 *  (c) 「重新生成」按钮再次调用 getPairingCode
 *  (d) 生成失败 → 错误态 + 重试按钮
 *
 * 二维码内容是上游 `buildPairingUri()` 的 NS1 七段串（serverId 形如 `server_` + 32 hex）。
 *
 * 运行：npx vitest run src/renderer/components/sync/PairingQrDialog.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PairingQrDialog } from './PairingQrDialog'

let getPairingCode: Mock

const QR_OFFER = {
  content: 'NS1|wxnn-0123456789abcdef|192.168.1.10|28080|tok|1893456000|' + 'ab'.repeat(32),
  expiresAt: '2026-10-11T12:05:00.000Z',
  serverId: 'wxnn-0123456789abcdef',
  host: '192.168.1.10',
  port: 28080,
  tlsFingerprintSha256: 'aa'.repeat(32)
}

function installElectronApi() {
  getPairingCode = vi.fn(async () => ({ ...QR_OFFER }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    nikkisync: { getPairingCode }
  }
}

beforeEach(() => {
  installElectronApi()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PairingQrDialog', () => {
  it('(a) 打开时拉取配对内容并渲染 QR SVG', async () => {
    const { container } = render(<PairingQrDialog open onClose={() => {}} />)
    await waitFor(() => expect(getPairingCode).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(container.querySelector('svg')).toBeInTheDocument())
  })

  it('(b) 展示服务地址（host:port）', async () => {
    render(<PairingQrDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('192.168.1.10:28080')).toBeInTheDocument())
  })

  it('(c) 重新生成按钮再次调用 getPairingCode', async () => {
    render(<PairingQrDialog open onClose={() => {}} />)
    await waitFor(() => expect(getPairingCode).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(getPairingCode).toHaveBeenCalledTimes(2))
  })

  it('(d) 生成失败 → 错误态 + 重试', async () => {
    getPairingCode.mockRejectedValueOnce(new Error('sync server is not running'))
    render(<PairingQrDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('生成配对二维码失败')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(getPairingCode).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('192.168.1.10:28080')).toBeInTheDocument())
  })

  it('(e) open=false 时不拉取', () => {
    render(<PairingQrDialog open={false} onClose={() => {}} />)
    expect(getPairingCode).not.toHaveBeenCalled()
  })
})
