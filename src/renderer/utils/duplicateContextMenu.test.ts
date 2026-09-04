import { describe, it, expect } from 'vitest'
import { toContextMenuMediaFile } from './duplicateContextMenu'
import type { DuplicateItem } from '../../shared/types/duplicate'

function makeItem(overrides: Partial<DuplicateItem> = {}): DuplicateItem {
  return {
    id: 1,
    file_path: '/a/b.jpg',
    file_name: 'b.jpg',
    file_type: 'image',
    file_size: 100,
    modified_at: '2024-01-01T00:00:00Z',
    width: 800,
    height: 600,
    is_favorite: false,
    rating: 0,
    ...overrides
  }
}

describe('toContextMenuMediaFile', () => {
  it('maps a valid image item to MediaFile', () => {
    const m = toContextMenuMediaFile(makeItem())
    expect(m).not.toBeNull()
    expect(m!.id).toBe('1')
    expect(m!.file_type).toBe('image')
    expect(m!.file_ext).toBe('jpg')
    expect(m!.scene_category).toBe('other')
    expect(m!.is_favorite).toBe(false)
    expect(m!.rating).toBe(0)
    expect(m!.file_size).toBe(100)
  })

  it('coerces video file_type', () => {
    const m = toContextMenuMediaFile(makeItem({ file_type: 'video' }))
    expect(m!.file_type).toBe('video')
  })

  it('derives lowercase file_ext from file_name', () => {
    expect(toContextMenuMediaFile(makeItem({ file_name: 'PHOTO.PNG' }))!.file_ext).toBe('png')
    expect(toContextMenuMediaFile(makeItem({ file_name: 'noext' }))!.file_ext).toBe('')
  })

  it('returns null when id is not a number', () => {
    expect(toContextMenuMediaFile(makeItem({ id: 'x' as unknown as number }))).toBeNull()
  })

  it('returns null when file_path is empty', () => {
    expect(toContextMenuMediaFile(makeItem({ file_path: '' }))).toBeNull()
  })

  it('falls back to undefined for missing width/height', () => {
    const m = toContextMenuMediaFile(makeItem({ width: undefined, height: undefined }))
    expect(m!.width).toBeUndefined()
    expect(m!.height).toBeUndefined()
  })
})
