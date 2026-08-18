/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { MediaFile } from '../../stores/mediaStore'

vi.mock('./InfoRowPanel', () => ({
  InfoRowPanel: (props: any) => (
    <div
      data-testid="info-row-panel"
      data-loading={props.loading ? 'true' : 'false'}
      data-error={props.error ?? ''}
      data-variant={props.variant}
      data-show-title={props.showTitle ? 'true' : 'false'}
      data-title={props.title}
      data-loading-text={props.loadingText}
      data-empty-text={typeof props.emptyText === 'string' ? props.emptyText : 'reactnode'}
    >
      <button data-testid="copy-btn" onClick={props.onCopy}>
        copy
      </button>
      <span data-testid="copied-flag">{props.copied ? 'true' : 'false'}</span>
    </div>
  )
}))

vi.mock('../../utils/enum-mappings', () => ({
  getPoseName: (id: number) => (id === 1 ? '站立' : null),
  getApertureName: (id: number) => (id === 1 ? 'F2.8' : null),
  getLightName: (id: string) => (id === 'light1' ? '日光' : null),
  getFilterName: (id: string) => (id === 'filter1' ? '滤镜A' : null)
}))

vi.mock('../../icons', () => ({
  IconCamera: (p: any) => <svg data-testid="icon-camera" {...p} />,
  IconInfo: (p: any) => <svg data-testid="icon-info" {...p} />
}))

// i18n mock：返回 camera 命名空间的中文值，保证组件渲染与 formatCameraForCopy 输出一致
const mockT = (key: string): string => {
  const map: Record<string, string> = {
    'camera.copyHeader': '=== 相机参数代码 ===',
    'camera.comparison': '镜头与构图',
    'camera.portraitMode': '竖构图',
    'camera.yes': '是',
    'camera.no': '否',
    'camera.zoom': '缩放',
    'camera.focalLength': '焦距',
    'camera.lensRotation': '镜头旋转',
    'camera.cameraYaw': '镜头偏航',
    'camera.cameraPitch': '镜头俯仰',
    'camera.cameraLoc': '相机位置',
    'camera.optic': '光学与光效',
    'camera.aperture': '光圈',
    'camera.bloomIntensity': '光晕',
    'camera.softIntensity': '柔光强度',
    'camera.bloomThreshold': '柔光范围',
    'camera.sectionAdjust': '画面调节',
    'camera.brightness': '亮度',
    'camera.exposure': '曝光',
    'camera.contrast': '对比度',
    'camera.saturation': '饱和度',
    'camera.vibrance': '自然饱和度',
    'camera.highlights': '高光',
    'camera.shadows': '阴影',
    'camera.scene': '场景与特效',
    'camera.light': '灯光',
    'camera.filter': '滤镜',
    'camera.pose': '动作场景',
    'camera.framedMoment': '定格',
    'camera.momoHidden': '隐藏大喵',
    'camera.hidden': '已隐藏',
    'camera.notHidden': '未隐藏',
    'camera.rawParams': '=== 原始参数 ===',
    'camera.cameraInfo': '相机信息',
    'camera.loading': '正在解析相机参数...',
    'camera.empty': '此图片未包含相机参数',
    'camera.errorPrefix': '参数解析失败',
    'camera.copyCode': '复制参数代码'
  }
  return map[key] ?? key
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'zh-CN' } })
}))

// useGameParams mock 状态
const mockGameParamsResult = {
  data: null as any,
  loading: false,
  error: null as string | null
}

vi.mock('../../hooks/useGameParams', () => ({
  useGameParams: () => mockGameParamsResult
}))

import { CameraInfoPanel, formatCameraForCopy } from './CameraInfoPanel'
import type { RichCameraParams } from '../../types/decryption'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    file_path: '/x.jpg',
    file_type: 'image',
    album_type: 'NikkiPhotos_HighQuality',
    account_uid: 'acc-1',
    ...over
  }) as unknown as MediaFile

const makeCamera = (over: Partial<RichCameraParams> = {}): RichCameraParams =>
  ({
    focalLength: 35,
    apertureSection: 1,
    brightness: 0,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    vibrance: 0,
    highlights: 0,
    shadows: 0,
    vignetteIntensity: 0,
    bloomIntensity: 0,
    bloomThreshold: 0,
    portraitMode: false,
    rawParams: 'raw-data',
    zoom: 1,
    rotation: 0,
    cameraYaw: 0,
    cameraPitch: 0,
    cameraLoc: null,
    pose: 0,
    framedMoment: 0,
    momoHidden: null,
    ...over
  }) as RichCameraParams

describe('CameraInfoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGameParamsResult.data = null
    mockGameParamsResult.loading = false
    mockGameParamsResult.error = null
  })

  it('file_type 非 image 时返回 null', () => {
    const { container } = render(<CameraInfoPanel file={makeFile({ file_type: 'video' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('file_type=image 但无 album_type 时返回 null', () => {
    const { container } = render(
      <CameraInfoPanel file={makeFile({ album_type: undefined as any })} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('enabled 时渲染 InfoRowPanel', () => {
    render(<CameraInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel')).toBeTruthy()
  })

  it('loading=true 时透传 loading 到 InfoRowPanel', () => {
    mockGameParamsResult.loading = true
    render(<CameraInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading')).toBe('true')
  })

  it('error 非 null 时透传 error 到 InfoRowPanel', () => {
    mockGameParamsResult.error = '解析失败'
    render(<CameraInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-error')).toBe('解析失败')
  })

  it('variant 透传到 InfoRowPanel', () => {
    render(<CameraInfoPanel file={makeFile()} variant="dark" />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-variant')).toBe('dark')
  })

  it('showTitle 透传到 InfoRowPanel', () => {
    render(<CameraInfoPanel file={makeFile()} showTitle={false} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-show-title')).toBe('false')
  })

  it('标题为"相机信息"', () => {
    render(<CameraInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-title')).toBe('相机信息')
  })

  it('loadingText 为"正在解析相机参数..."', () => {
    render(<CameraInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading-text')).toBe(
      '正在解析相机参数...'
    )
  })

  it('点击复制按钮后 copied 标志变为 true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })
    mockGameParamsResult.data = { camera: makeCamera() }

    render(<CameraInfoPanel file={makeFile()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-btn'))
    })
    expect(screen.getByTestId('copied-flag').textContent).toBe('true')
  })

  it('data.camera 为 null 时点击复制按钮不调用 clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })
    mockGameParamsResult.data = { camera: null }

    render(<CameraInfoPanel file={makeFile()} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-btn'))
    })
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('formatCameraForCopy', () => {
  it('camera=null 返回基础标题与空原始参数', () => {
    const text = formatCameraForCopy(null as any, mockT)
    expect(text).toContain('=== 相机参数代码 ===')
  })

  it('camera 包含完整数据时返回格式化文本', () => {
    const camera = makeCamera({
      portraitMode: true,
      zoom: 1.5,
      focalLength: 50,
      rotation: 30,
      apertureSection: 1,
      brightness: 0.5
    })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('=== 相机参数代码 ===')
    expect(text).toContain('镜头与构图')
    expect(text).toContain('竖构图: 是')
    expect(text).toContain('缩放: 1.50x')
    expect(text).toContain('焦距: 50.0mm')
    expect(text).toContain('镜头旋转: 30.0°')
    expect(text).toContain('光学与光效')
    expect(text).toContain('光圈: F2.8')
    expect(text).toContain('画面调节')
    expect(text).toContain('亮度: 50%')
  })

  it('camera 包含 light 时显示灯光信息', () => {
    const camera = makeCamera({
      light: { id: 'light1', strength: 0.8 }
    })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('灯光: 日光 (80%)')
  })

  it('camera 包含 filter 时显示滤镜信息', () => {
    const camera = makeCamera({
      filter: { id: 'filter1', strength: 0.6 }
    })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('滤镜: 滤镜A (60%)')
  })

  it('camera 包含 pose 时显示动作场景', () => {
    const camera = makeCamera({ pose: 1 })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('动作场景: 站立')
  })

  it('camera 包含 rawParams 时显示原始参数', () => {
    const camera = makeCamera({ rawParams: 'RAW_PARAM_STRING' })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('=== 原始参数 ===')
    expect(text).toContain('RAW_PARAM_STRING')
  })

  it('camera 包含 cameraLoc 时显示相机位置', () => {
    const camera = makeCamera({
      cameraLoc: { x: 1.5, y: 2.5, z: 3.5 }
    })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('相机位置: (1.5, 2.5, 3.5)')
  })

  it('camera 包含 momoHidden=enabled 时显示已隐藏', () => {
    const camera = makeCamera({ momoHidden: 'enabled' })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('隐藏大喵: 已隐藏')
  })

  it('camera 包含 momoHidden=disabled 时显示未隐藏', () => {
    const camera = makeCamera({ momoHidden: 'disabled' })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('隐藏大喵: 未隐藏')
  })

  it('camera 包含 framedMoment 时显示定格', () => {
    const camera = makeCamera({ framedMoment: 42 })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('定格: #42')
  })

  it('camera 各字段为 0 时不显示对应行（除非是布尔）', () => {
    const camera = makeCamera({ cameraYaw: 0, cameraPitch: 0, pose: 0, framedMoment: 0 })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).not.toContain('镜头偏航')
    expect(text).not.toContain('镜头俯仰')
    expect(text).not.toContain('动作场景')
    expect(text).not.toContain('定格')
  })

  it('camera 全部字段未填时仅返回标题', () => {
    const camera = makeCamera({
      portraitMode: false,
      zoom: undefined as any,
      focalLength: undefined as any,
      rotation: undefined as any,
      cameraYaw: undefined as any,
      cameraPitch: undefined as any,
      cameraLoc: null,
      pose: undefined as any,
      framedMoment: undefined as any,
      momoHidden: null,
      apertureSection: undefined as any,
      bloomIntensity: undefined as any,
      vignetteIntensity: undefined as any,
      bloomThreshold: undefined as any,
      brightness: undefined as any,
      exposure: undefined as any,
      contrast: undefined as any,
      saturation: undefined as any,
      vibrance: undefined as any,
      highlights: undefined as any,
      shadows: undefined as any,
      light: undefined as any,
      filter: undefined as any,
      rawParams: undefined as any
    })
    const text = formatCameraForCopy(camera as any, mockT)
    expect(text).toContain('=== 相机参数代码 ===')
    expect(text).toContain('竖构图: 否')
    expect(text).not.toContain('=== 原始参数 ===')
  })
})
