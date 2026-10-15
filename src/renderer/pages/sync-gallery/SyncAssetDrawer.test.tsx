// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

describe('SyncAssetDrawer', () => {
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
})
