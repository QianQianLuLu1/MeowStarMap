/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/components/gallery/*
 * @coverage 图库四视图卡片选中态语义类（fix-image-selection-border-visibility）
 * @dependencies @testing-library/react、./MasonryView、fs（源码结构断言）
 * @remarks
 *   缺陷：四个卡片视图（网格 / 时间线 / 事件时间线 / 瀑布流）用 Tailwind 临时拼装的
 *   `ring-2 ring-offset-2` + 内联 `--tw-ring-color` 表达选中态，导致：
 *     R1 ring-offset 偏移色恒为 Tailwind 默认 #fff，深/柔粉底上露白圈；
 *     R2 与 hover 的 ::after border 两套描边机制互相吞没，选中态失去层次。
 *
 *   修复：四处统一改用语义类 `is-selected`，样式集中到 globals.css 的
 *   `.media-card.is-selected`（可被主题覆盖），组件不再内联任何描边色。
 *
 *   测试策略：VirtualImageGrid / TimelineView / EventTimelineView 依赖 react-virtuoso
 *   与大量子组件，直接 render 需 mock 数十个模块且脆弱（见 VirtualImageGrid.thumb.test.tsx
 *   头部说明），故走源码结构断言；MasonryView 已有可渲染测试（MasonryView.test.tsx），
 *   在此承载渲染级断言，验证真实 DOM 上的 className 计算。
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import fs from 'fs'
import path from 'path'
import { MasonryView } from './MasonryView'
import type { MediaFile } from '../../stores/mediaStore'

function makeFile(id: string): MediaFile {
  return {
    id,
    file_name: `file-${id}.png`,
    file_path: `/tmp/${id}.png`,
    thumbnail: `/tmp/${id}.png`,
    file_type: 'image',
    width: 200,
    height: 300,
    is_missing: false,
    is_corrupted: false
  } as unknown as MediaFile
}

const files: MediaFile[] = [makeFile('1'), makeFile('2'), makeFile('3')]

// jsdom 下 clientWidth/clientHeight 默认 0，注入固定尺寸驱动 masonic 布局
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1200
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 4000
  })
})

afterEach(() => {
  cleanup()
})

/** 读取组件源码并剔除整行注释，避免修复说明注释误命中否定断言 */
function readCode(...segments: string[]): string {
  const src = fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf-8')
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

const VIEW_FILES = [
  'VirtualImageGrid.tsx',
  'TimelineView.tsx',
  'EventTimelineView.tsx',
  'MasonryView.tsx'
] as const

describe('四视图选中态语义类（fix-image-selection-border-visibility）', () => {
  describe('渲染级：MasonryView 选中 / 未选中 className 计算', () => {
    it('正常：选中卡片带 is-selected 语义类，未选中卡片不带', () => {
      render(<MasonryView files={files} selectedIds={['2']} onSelect={() => {}} />)
      const selected = document.querySelector('[data-media-id="2"]') as HTMLElement
      const unselected = document.querySelector('[data-media-id="1"]') as HTMLElement
      expect(selected.className).toContain('is-selected')
      expect(unselected.className).not.toContain('is-selected')
    })

    it('正常：选中 / 未选中卡片均不再拼装 ring-offset（消除恒为 #fff 的露白圈）', () => {
      render(<MasonryView files={files} selectedIds={['2']} onSelect={() => {}} />)
      for (const el of Array.from(document.querySelectorAll('.media-card'))) {
        expect(el.className).not.toContain('ring-offset')
      }
    })

    it('边界：多选模式下勾选框 aria-checked 与卡片 is-selected 语义类同步', () => {
      render(
        <MasonryView
          files={files}
          selectedIds={['2']}
          onSelect={() => {}}
          multiSelectMode
          onToggleSelection={() => {}}
        />
      )
      const checkboxes = Array.from(
        document.querySelectorAll('[data-testid="media-checkbox"]')
      ) as HTMLElement[]
      expect(checkboxes.length).toBe(3)
      const checked = checkboxes.map((el) => el.getAttribute('aria-checked'))
      expect(checked).toEqual(['false', 'true', 'false'])
      const selectedCard = document.querySelector('[data-media-id="2"]') as HTMLElement
      expect(selectedCard.className).toContain('is-selected')
    })
  })

  describe('源码结构：四视图统一改用 is-selected', () => {
    for (const file of VIEW_FILES) {
      it(`核心：${file} 改用 is-selected 语义类`, () => {
        const code = readCode('src', 'renderer', 'components', 'gallery', file)
        expect(code).toContain("'is-selected'")
      })

      it(`核心：${file} 不再拼装 ring-offset-2 与内联 --tw-ring-color`, () => {
        const code = readCode('src', 'renderer', 'components', 'gallery', file)
        expect(code).not.toContain('ring-offset-2')
        expect(code).not.toContain('--tw-ring-color')
      })
    }
  })

  describe('边界：选中态不破坏既有行为', () => {
    it('异常：缩略图加载失败降级为占位图后，选中语义类仍在（描边与图片状态解耦）', () => {
      render(<MasonryView files={files} selectedIds={['1']} onSelect={() => {}} />)
      const card = document.querySelector('[data-media-id="1"]') as HTMLElement
      const img = card.querySelector('[data-testid="thumb"]') as HTMLImageElement
      fireEvent.error(img)
      expect(card.querySelector('[data-testid="thumb"]')).toBeNull()
      expect(card.className).toContain('is-selected')
    })
  })
})
