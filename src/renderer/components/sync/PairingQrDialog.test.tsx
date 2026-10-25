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

  // ===== K5：多 host 备选地址清单 =====

  it('(f) K5：offer 带 hosts ⇒ 渲染备选地址清单；单 host（无 hosts）界面不变', async () => {
    getPairingCode = vi.fn(async () => ({
      ...QR_OFFER,
      content:
        'nikki-sync://pair?serverId=wxnn-0123456789abcdef&host=192.168.1.10&port=28080&token=tok&protocol=1&expiresAt=2026-10-11T12%3A05%3A00.000Z&tls=' +
        'ab'.repeat(32) +
        '&hosts=192.168.1.10,192.168.1.11,192.168.1.12',
      hosts: ['192.168.1.10', '192.168.1.11', '192.168.1.12']
    }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      nikkisync: { getPairingCode }
    }
    const first = render(<PairingQrDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('备选地址')).toBeInTheDocument())
    // 清单为 join 后的单个文本块（主地址已单独展示，不重复列出）
    expect(screen.getByText('192.168.1.11 · 192.168.1.12')).toBeInTheDocument()
    first.unmount()

    // 单 host：无备选地址区（恢复默认桩——QR_OFFER 无 hosts）
    installElectronApi()
    render(<PairingQrDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('192.168.1.10:28080')).toBeInTheDocument())
    expect(screen.queryByText('备选地址')).toBeNull()
  })
})
