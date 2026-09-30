import React from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { IconShare, IconWeChat, IconQQ, IconVivo } from './index'

/**
 * 分享家族图标多尺寸故事：视觉验收「分享图标显示不完全」修复效果。
 * 2026-09-30：IconShare 已整体替换为 Lucide share-2（三节点网络，ISC License）——
 * 原「WiFi 弧线 + 圆点」字形外弧悬空截断、观感如被遮挡一半，设计本身被否决。
 * 64px 档供放大目检三节点与连线是否完整清晰（无裁切、无贴边）。
 * 几何与指纹守卫：`src/renderer/icons/index.test.tsx`（`npx vitest run src/renderer/icons/index.test.tsx`）。
 */

const SIZES = [14, 16, 28, 64] as const

const FAMILY: Array<{ name: string; Icon: React.FC<{ size?: number }> }> = [
  { name: 'IconShare（分享 / WiFi 分享）', Icon: IconShare },
  { name: 'IconWeChat（微信）', Icon: IconWeChat },
  { name: 'IconQQ（QQ）', Icon: IconQQ },
  { name: 'IconVivo（vivo 办公）', Icon: IconVivo }
]

const ShareIconFamilyGrid: React.FC = () => (
  <div className="p-6" style={{ color: 'var(--text-primary)' }}>
    <table style={{ borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ padding: '8px 16px', textAlign: 'left' }}>图标 \ 尺寸</th>
          {SIZES.map((size) => (
            <th key={size} style={{ padding: '8px 16px' }}>
              {size}
              {size === 64 ? '（放大目检）' : ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {FAMILY.map(({ name, Icon }) => (
          <tr key={name}>
            <td style={{ padding: '8px 16px', whiteSpace: 'nowrap' }}>{name}</td>
            {SIZES.map((size) => (
              <td key={size} style={{ padding: '8px 16px', textAlign: 'center' }}>
                {/* 定宽格子 + 边框：便于观察图标是否贴边被裁 */}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: size + 8,
                    height: size + 8,
                    border: '1px dashed var(--divider, #888)'
                  }}
                >
                  <Icon size={size} />
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

const meta: Meta<typeof ShareIconFamilyGrid> = {
  title: 'Icons/ShareIconFamily',
  component: ShareIconFamilyGrid,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          '分享家族图标（IconShare / IconWeChat / IconQQ / IconVivo）在 14 / 16 / 28 / 64 四档尺寸下的渲染网格。' +
          '14 为批量操作栏用法、16 为右键菜单用法、28 为 ShareGuideDialog 用法、64 供放大目检。' +
          '验收点：IconShare 为 Lucide share-2 三节点网络字形（2026-09-30 替换），三节点与连线完整清晰、' +
          '无裁切贴边——原「WiFi 弧线 + 圆点」字形外弧悬空截断，观感如被遮挡一半。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof ShareIconFamilyGrid>

/** 分享家族图标多尺寸网格（含 64px 放大目检档） */
export const ShareIconFamily: Story = {}
