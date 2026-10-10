import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { BannerWishButton } from './BannerWishButton'
import { GlobalToastContext } from '../common/ToastProvider'
import { useResonanceStore, toggleBannerWish } from '../../stores/resonanceStore'

/**
 * BannerWishButton 组件测试：store 的 toggleBannerWish 打桩，
 * 验证按下态取自 store.wishlist、点击透传 bannerId、写失败时经全局 toast 反馈。
 */

vi.mock('../../stores/resonanceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/resonanceStore')>()
  return { ...actual, toggleBannerWish: vi.fn() }
})

const mockToggle = vi.mocked(toggleBannerWish)

function resetStore(wishlist: { version: 1; entries: Array<{ bannerId: number }> }): void {
  useResonanceStore.setState({ wishlist })
}

describe('BannerWishButton', () => {
  beforeEach(() => {
    mockToggle.mockReset()
    mockToggle.mockResolvedValue({ version: 1, entries: [{ bannerId: 74 }] })
  })
  afterEach(cleanup)

  it('未收藏时 aria-pressed=false，点击以当前卡池 id 调用 toggleBannerWish', () => {
    resetStore({ version: 1, entries: [] })
    render(<BannerWishButton bannerId={74} />)
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(mockToggle).toHaveBeenCalledWith(74)
  })

  it('已收藏时 aria-pressed=true（同一按钮承载加入/移出两种语义）', () => {
    resetStore({ version: 1, entries: [{ bannerId: 74 }] })
    render(<BannerWishButton bannerId={74} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  })

  it('切换失败时经全局 toast 反馈错误，且不吞异常', async () => {
    const show = vi.fn()
    mockToggle.mockRejectedValue(new Error('wishlist write failed'))
    resetStore({ version: 1, entries: [] })
    render(
      <GlobalToastContext.Provider value={show}>
        <BannerWishButton bannerId={74} />
      </GlobalToastContext.Provider>
    )
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1))
    expect(show.mock.calls[0]![1]).toBe('error')
  })

  it('写入进行中禁止重复点击（避免乐观更新互相覆盖）', async () => {
    const holder: { release?: () => void } = {}
    mockToggle.mockReturnValue(
      new Promise((resolve) => {
        holder.release = () => resolve({ version: 1, entries: [{ bannerId: 74 }] })
      })
    )
    resetStore({ version: 1, entries: [] })
    render(<BannerWishButton bannerId={74} />)
    const button = screen.getByRole('button')
    fireEvent.click(button)
    await waitFor(() => expect(button).toBeDisabled())
    fireEvent.click(button)
    expect(mockToggle).toHaveBeenCalledTimes(1)
    holder.release?.()
  })
})
