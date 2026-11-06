// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { AssetMediaFile } from '../../utils/assetViewModel'

/**
 * 阶段 5 · A3：详情抽屉。
 * 五个参数面板替身接管（各自的行为由自己的套件覆盖），本文件只锁抽屉的**装配**：
 * 基本信息完整（含 LIVE 标识与哈希）、面板都挂上、关闭态不渲染。
 */

vi.mock('../../components/common/PhotographyPanel', () => ({
  PhotographyPanel: () => <div data-testid="panel-photography" />
}))
vi.mock('../../components/common/CameraInfoPanel', () => ({
  CameraInfoPanel: () => <div data-testid="panel-camera" />
}))
vi.mock('../../components/common/NikkiInfoPanel', () => ({
  NikkiInfoPanel: () => <div data-testid="panel-nikki" />
}))
vi.mock('../../components/common/OutfitPanel', () => ({
  OutfitPanel: () => <div data-testid="panel-outfit" />
}))
vi.mock('../../components/common/InteractionPanel', () => ({
  InteractionPanel: () => <div data-testid="panel-interaction" />
}))

import { SyncAssetDrawer } from './SyncAssetDrawer'

function asset(over: Partial<AssetMediaFile> = {}): AssetMediaFile {
  return {
    id: 'a/1',
    file_path: 'D:/Game/NikkiPhotos_HighQuality/a/1.png',
    file_name: 'a1.png',
    file_type: 'image',
    file_ext: '.png',
    file_size: 5242880,
    width: 4096,
    height: 2160,
    created_at: '2026-10-01T08:00:00.000Z',
    modified_at: '2026-10-01T08:00:00.000Z',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    album_type: 'HQ',
    account_uid: 'u-1',
    nikkisync: {
      assetId: 'a/1',
      assetType: 'motion_photo',
      state: 'ready',
      revision: 7,
      hasMotion: true,
      hasMetadata: false,
      gameVersion: '1.3',
      sha256: 'deadbeef',
      motionVideoPath: 'D:/Game/motion/a1.mp4'
    },
    ...over
  } as unknown as AssetMediaFile
}

/**
 * N5：抽屉假桥装配。默认给一个「老桥面」（没有 getAssetDetail），让既有装配用例同步走
 * legacy、不被上游请求的异步 setState 打扰；需要上游链路的用例再显式覆盖。
 */
function installDrawerBridge(
  over: { detail?: unknown; detailError?: Error; withGetAssetDetail?: boolean } = {}
): ReturnType<typeof vi.fn> {
  const getAssetDetail = vi.fn(async () => {
    if (over.detailError) throw over.detailError
    return over.detail
  })
  const nikkisync: Record<string, unknown> = {}
  if (over.withGetAssetDetail !== false) nikkisync.getAssetDetail = getAssetDetail
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    nikkisync,
    decrypt: { decodeFile: vi.fn(async () => ({ ok: true, data: {} })) }
  }
  return getAssetDetail
}

describe('SyncAssetDrawer', () => {
  beforeEach(() => {
    installDrawerBridge({ withGetAssetDetail: false })
  })

  it('关闭态不渲染任何内容', () => {
    render(<SyncAssetDrawer open={false} file={asset()} onClose={vi.fn()} />)
    expect(screen.queryByTestId('panel-outfit')).toBeNull()
  })

  it('打开时挂满五个参数面板', () => {
    render(<SyncAssetDrawer open onClose={vi.fn()} file={asset()} />)
    for (const key of ['photography', 'camera', 'nikki', 'outfit', 'interaction']) {
      expect(screen.getByTestId(`panel-${key}`), `缺少面板 ${key}`).toBeTruthy()
    }
  })

  it('基本信息区保留哈希、LIVE 标识、分辨率与 revision', () => {
    render(<SyncAssetDrawer open onClose={vi.fn()} file={asset()} />)
    expect(screen.getByText('deadbeef')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
    expect(screen.getByText(/4096\s*×\s*2160/)).toBeTruthy()
    // LIVE 标识来自 nikkisync.hasMotion
    expect(screen.getByTestId('drawer-root').getAttribute('data-has-motion')).toBe('true')
  })

  it('无 nikkisync 附加信息时不崩，字段如实缺省', () => {
    const bare = asset()
    delete bare.nikkisync
    render(<SyncAssetDrawer open onClose={vi.fn()} file={bare} />)
    expect(screen.getByTestId('panel-outfit')).toBeTruthy()
  })

  // ===== K3：游戏版本推断行 =====

  function installGameVersionApi(result: { version?: string; effectiveAt?: string } | Error): void {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      nikkisync: {
        resolveGameVersion:
          result instanceof Error
            ? vi.fn(() => Promise.reject(result))
            : vi.fn(() => Promise.resolve(result))
      }
    }
  }

  it('K3：metadata 无版本时按拍摄时间推断展示（成功才渲染，标注推断）', async () => {
    installGameVersionApi({ version: '2.5', effectiveAt: '2026-04-24T03:00:00.000Z' })
    const noVersion = asset()
    delete noVersion.nikkisync?.gameVersion
    render(<SyncAssetDrawer open onClose={vi.fn()} file={noVersion} />)
    expect(await screen.findByText(/2\.5/)).toBeTruthy()
    expect(await screen.findByText(/（推断）/)).toBeTruthy()
  })

  it('K3：metadata 自带版本与推断不同 ⇒ 并列展示；通道失败只显示自带版本', async () => {
    installGameVersionApi({ version: '2.5' })
    const withVersion = asset({ created_at: '2026-05-01T00:00:00.000Z' })
    const first = render(<SyncAssetDrawer open onClose={vi.fn()} file={withVersion} />)
    // metadata 自带 1.3，推断 2.5：两者并列（自带值在前）
    expect(await first.findByText(/1\.3/)).toBeTruthy()
    expect(await first.findByText(/2\.5/)).toBeTruthy()
    first.unmount()

    // 通道失败/未装配 ⇒ 不渲染推断值（自带版本仍显示）
    installGameVersionApi(new Error('not ready'))
    const second = render(
      <SyncAssetDrawer
        open
        onClose={vi.fn()}
        file={asset({ created_at: '2026-05-01T00:00:00.000Z' })}
      />
    )
    expect(await second.findByText(/1\.3/)).toBeTruthy()
    expect(second.queryByText(/2\.5/)).toBeNull()
  })

  // ===== N5：优先上游 metadata，失败/桥缺失回落本地解密链 =====

  it('loads upstream asset metadata via getAssetDetail when opened', async () => {
    const getAssetDetail = installDrawerBridge({
      detail: {
        asset: { metadata: { camera: { focalLength: 85, apertureSection: 2.8 } } }
      }
    })
    render(<SyncAssetDrawer open onClose={vi.fn()} file={asset()} />)
    await waitFor(() => expect(getAssetDetail).toHaveBeenCalledTimes(1))
    expect(getAssetDetail).toHaveBeenCalledWith('a/1')
    const panel = await screen.findByTestId('drawer-upstream-panel')
    expect(panel.textContent).toContain('85')
    await waitFor(() =>
      expect(screen.getByTestId('drawer-root').getAttribute('data-metadata-source')).toBe(
        'upstream'
      )
    )
  })

  it('falls back to local decoded metadata when getAssetDetail fails', async () => {
    const getAssetDetail = installDrawerBridge({
      detailError: new Error('runtime is not ready')
    })
    render(<SyncAssetDrawer open onClose={vi.fn()} file={asset()} />)
    await waitFor(() => expect(getAssetDetail).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('drawer-metadata-fallback-notice')).toBeTruthy()
    // 五个本地参数面板仍在 ⇒ decrypt:decodeFile 回落链保留，不整块替换
    for (const key of ['photography', 'camera', 'nikki', 'outfit', 'interaction']) {
      expect(screen.getByTestId(`panel-${key}`), `缺少回落面板 ${key}`).toBeTruthy()
    }
    expect(screen.getByTestId('drawer-root').getAttribute('data-metadata-source')).toBe('local')
  })

  it('bridge without getAssetDetail keeps legacy rendering', () => {
    installDrawerBridge({ withGetAssetDetail: false })
    render(<SyncAssetDrawer open onClose={vi.fn()} file={asset()} />)
    expect(screen.getByTestId('drawer-root').getAttribute('data-metadata-source')).toBe('legacy')
    expect(screen.queryByTestId('drawer-upstream-panel')).toBeNull()
    expect(screen.queryByTestId('drawer-metadata-fallback-notice')).toBeNull()
    for (const key of ['photography', 'camera', 'nikki', 'outfit', 'interaction']) {
      expect(screen.getByTestId(`panel-${key}`), `缺少 legacy 面板 ${key}`).toBeTruthy()
    }
  })
})
