import React, { useEffect, useRef, useMemo, useState, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: React.ReactNode
  divider?: boolean
  danger?: boolean
  disabled?: boolean
  // P2-C6：onClick 改为可选，divider 项不需要 onClick
  onClick?: () => void
  // T09：二级子菜单（如「分享」展开三个渠道）
  submenu?: ContextMenuItem[]
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [activeIndex, setActiveIndex] = React.useState(0)
  // T09：当前展开的子菜单索引（鼠标 hover 项时切换）
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null)
  const submenuRef = useRef<HTMLDivElement>(null)

  // 修复 U-S5：focusableIndices 用 useMemo 记忆化，避免每次渲染新数组导致 effect 反复重跑
  const focusableIndices = useMemo(
    () => items.map((item, index) => (item.divider ? -1 : index)).filter((i) => i >= 0),
    [items]
  )

  // 修复 U-S5：视口边界检测，菜单超出视口时反向定位
  // 修复显示不全：菜单高度超过视口时限制 maxHeight 并允许滚动，top 钳制为非负值
  const [position, setPosition] = useState({ left: x, top: y })
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    // 可用最大高度：从 top 到视口底部减去边距
    const availableHeight = window.innerHeight - y - 8
    // 菜单实际高度超过可用空间时启用滚动
    if (rect.height > availableHeight) {
      setMaxHeight(Math.max(160, availableHeight))
      // 高度受限后向上偏移到视口顶部留 8px 边距
      top = 8
    } else {
      setMaxHeight(undefined)
      // 下边界超出：向上偏移菜单高度
      if (y + rect.height > window.innerHeight) {
        top = Math.max(8, window.innerHeight - rect.height - 8)
      }
    }
    // 右边界超出：向左偏移菜单宽度
    if (x + rect.width > window.innerWidth) {
      left = Math.max(8, window.innerWidth - rect.width - 8)
    }
    setPosition({ left, top })
  }, [x, y])

  // T09：子菜单定位（父项右侧，超出视口时左侧）
  const [submenuPos, setSubmenuPos] = useState({ left: 0, top: 0 })
  const [submenuMaxHeight, setSubmenuMaxHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (submenuIndex === null) return
    const parent = itemRefs.current[submenuIndex]
    const sub = submenuRef.current
    if (!parent || !sub) return
    const pRect = parent.getBoundingClientRect()
    const sRect = sub.getBoundingClientRect()
    let left = pRect.right
    let top = pRect.top
    if (left + sRect.width > window.innerWidth) {
      left = Math.max(8, pRect.left - sRect.width)
    }
    // 子菜单高度超过视口可用空间时限制 maxHeight 并允许滚动
    const availableHeight = window.innerHeight - top - 8
    if (sRect.height > availableHeight) {
      setSubmenuMaxHeight(Math.max(160, availableHeight))
      top = 8
    } else {
      setSubmenuMaxHeight(undefined)
      if (top + sRect.height > window.innerHeight) {
        top = Math.max(8, window.innerHeight - sRect.height - 8)
      }
    }
    setSubmenuPos({ left, top })
  }, [submenuIndex])

  // P1 修复：activeIndex 用 ref 读取最新值，避免每次键盘导航都重注册监听器
  // 原 useEffect 依赖 [onClose, items, focusableIndices, activeIndex]，activeIndex 频繁变化导致
  // 监听器反复解绑/重绑，且每次重绑都会强制把焦点拉回第一项，破坏键盘导航体验
  const activeIndexRef = React.useRef(0)
  useEffect(() => {
    activeIndexRef.current = activeIndex
  }, [activeIndex])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // P0 修复：右键按下（button=2）由 contextmenu 事件处理，不在此关闭菜单
      // 否则在卡片上再次右键时，mousedown 先关闭菜单，contextmenu 又重开，造成闪烁
      if (e.button === 2) return
      // T09：点击子菜单内部不关闭父菜单
      if (submenuRef.current && submenuRef.current.contains(e.target as Node)) return
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((prev) => {
          const next = prev + 1 >= focusableIndices.length ? 0 : prev + 1
          itemRefs.current[focusableIndices[next]]?.focus()
          return next
        })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((prev) => {
          const next = prev - 1 < 0 ? focusableIndices.length - 1 : prev - 1
          itemRefs.current[focusableIndices[next]]?.focus()
          return next
        })
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        // P1 修复：从 ref 读取最新 activeIndex，避免闭包陈旧值
        const itemIndex = focusableIndices[activeIndexRef.current]
        const item = itemIndex >= 0 ? items[itemIndex] : undefined
        // T09：有子菜单的项不直接触发 onClick
        if (item && !item.disabled && !item.submenu) {
          item.onClick?.()
          onClose()
        }
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    if (focusableIndices.length > 0) {
      itemRefs.current[focusableIndices[0]]?.focus()
    }
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, items, focusableIndices])

  return createPortal(
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={t('common.contextMenu.ariaLabel')}
        className="fixed z-[90] glass-panel py-1 min-w-[200px] overflow-y-auto"
        style={{
          left: position.left,
          top: position.top,
          maxHeight: maxHeight,
          animation: 'scaleIn 150ms ease-out'
        }}
      >
        {items.map((item, index) =>
          item.divider ? (
            <div
              key={item.id}
              role="separator"
              className="my-1 h-px"
              style={{ background: 'var(--divider)' }}
            />
          ) : (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left"
              style={{
                color: item.danger ? 'var(--danger)' : 'var(--text-primary)',
                opacity: item.disabled ? 0.4 : 1,
                cursor: item.disabled ? 'not-allowed' : 'pointer',
                background: submenuIndex === index ? 'var(--hover-bg)' : 'transparent'
              }}
              onMouseEnter={() => {
                setSubmenuIndex(item.submenu ? index : null)
              }}
              onClick={() => {
                if (item.disabled) return
                // T09：有子菜单的项点击仅切换子菜单，不关闭父菜单
                if (item.submenu) {
                  setSubmenuIndex(submenuIndex === index ? null : index)
                  return
                }
                item.onClick?.()
                onClose()
              }}
            >
              {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.submenu && <span className="flex-shrink-0 text-xs opacity-60">▶</span>}
            </button>
          )
        )}
      </div>

      {/* T09：二级子菜单 */}
      {submenuIndex !== null && items[submenuIndex]?.submenu && (
        <div
          ref={submenuRef}
          role="menu"
          aria-label={t('common.contextMenu.submenuAriaLabel', {
            label: items[submenuIndex].label
          })}
          className="fixed z-[91] glass-panel py-1 min-w-[220px] overflow-y-auto"
          style={{
            left: submenuPos.left,
            top: submenuPos.top,
            maxHeight: submenuMaxHeight,
            animation: 'scaleIn 150ms ease-out'
          }}
          onMouseLeave={() => setSubmenuIndex(null)}
        >
          {items[submenuIndex].submenu!.map((sub) => (
            <button
              key={sub.id}
              role="menuitem"
              tabIndex={-1}
              disabled={sub.disabled}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left"
              style={{
                color: sub.danger ? 'var(--danger)' : 'var(--text-primary)',
                opacity: sub.disabled ? 0.4 : 1,
                cursor: sub.disabled ? 'not-allowed' : 'pointer'
              }}
              onClick={() => {
                if (sub.disabled) return
                sub.onClick?.()
                onClose()
              }}
            >
              {sub.icon && <span className="flex-shrink-0">{sub.icon}</span>}
              {/* P0 修复：统一父/子菜单文字布局，加 flex-1 min-w-0 truncate 防止长标签被挤压 */}
              <span className="flex-1 min-w-0 truncate">{sub.label}</span>
            </button>
          ))}
        </div>
      )}
    </>,
    document.body
  )
}
