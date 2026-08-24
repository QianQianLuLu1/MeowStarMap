import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { PropertiesDialog } from './PropertiesDialog'
import type { MediaFile } from '../../stores/mediaStore'

/**
 * 文件属性对话框故事。
 * 全部文案走既有 i18n key（common.propertiesDialog.*）。
 * 依赖 window.electronAPI（shell.showItemInFolder / file.getExif / decrypt.decodeFile），
 * 由全局安全桩承接；示例文件不带 album_type，故不触发游戏参数解密请求。
 */
const demoImageFile: MediaFile = {
  id: 'demo-image-1',
  file_path: 'D:\\InfinityNikki\\Photos\\NikkiPhotos_HighQuality\\IMG_20260823_120000.jpg',
  file_name: 'IMG_20260823_120000.jpg',
  file_type: 'image',
  file_ext: '.jpg',
  file_size: 4_286_512,
  width: 3840,
  height: 2160,
  created_at: '2026-08-23T12:00:00',
  modified_at: '2026-08-23T12:00:03',
  tags: ['风景', '暖暖的旅程'],
  rating: 4,
  is_favorite: true,
  notes: '',
  scene_category: 'screenshot',
  scene_time: 'day'
}

const demoVideoFile: MediaFile = {
  ...demoImageFile,
  id: 'demo-video-1',
  file_path: 'D:\\InfinityNikki\\Videos\\REC_20260822_1830.mp4',
  file_name: 'REC_20260822_1830.mp4',
  file_type: 'video',
  file_ext: '.mp4',
  file_size: 128_450_560,
  width: 2560,
  height: 1440,
  duration: 62,
  scene_category: 'other',
  scene_time: 'unknown'
}

const meta: Meta<typeof PropertiesDialog> = {
  title: 'Common/PropertiesDialog',
  component: PropertiesDialog,
  tags: ['autodocs'],
  argTypes: {
    file: { control: false }
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          '文件属性对话框：基础信息 + EXIF / 拍摄 / 相机 / 暖暖 / 搭配 / 交互物六个面板，支持「打开所在目录」与「复制全部」。' +
          '依赖 `window.electronAPI`：`shell.showItemInFolder`（打开目录）、`file.getExif`（复制时拼 EXIF）、' +
          '`decrypt.decodeFile`（仅游戏内拍摄文件，即带 `album_type` 时），Storybook 中均由全局桩承接。' +
          '`open && file` 双条件为真才渲染。' +
          '无障碍要点：标题绑定 `aria-labelledby`，初始焦点落在底部关闭按钮，焦点陷阱与 Esc 关闭由 BaseDialog 提供。' +
          '同置测试：`PropertiesDialog.test.tsx`（`npm run test:renderer -- src/renderer/components/common/PropertiesDialog.test.tsx`）。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof PropertiesDialog>

/** 图片文件：完整面板结构（示例不含 album_type，游戏参数面板为空态） */
export const Default: Story = {
  args: {
    open: true,
    file: demoImageFile,
    onClose: fn()
  },
  render: function Render(args) {
    const [open, setOpen] = useState(true)
    return (
      <>
        {!open && (
          <button className="btn-primary" onClick={() => setOpen(true)}>
            打开属性对话框
          </button>
        )}
        <PropertiesDialog
          {...args}
          open={open}
          onClose={() => {
            setOpen(false)
            args.onClose?.()
          }}
        />
      </>
    )
  }
}

/** 视频文件：类型文案与时长字段差异 */
export const VideoFile: Story = {
  args: {
    open: true,
    file: demoVideoFile,
    onClose: fn()
  },
  render: function Render(args) {
    const [open, setOpen] = useState(true)
    return (
      <>
        {!open && (
          <button className="btn-primary" onClick={() => setOpen(true)}>
            打开属性对话框
          </button>
        )}
        <PropertiesDialog
          {...args}
          open={open}
          onClose={() => {
            setOpen(false)
            args.onClose?.()
          }}
        />
      </>
    )
  }
}
