import type { TFunction } from 'i18next'
import type { ContextMenuItem } from '../components/common/ContextMenu'
import type { ShareChannelId } from '../components/common/ShareGuideDialog'
import type { MediaFile } from '../stores/mediaStore'
import {
  IconOpen,
  IconEdit,
  IconSaveAs,
  IconExport,
  IconCopy,
  IconMove,
  IconRename,
  IconFavorite,
  IconDelete,
  IconProperties,
  IconSelectAll,
  IconShare,
  IconWeChat,
  IconQQ,
  IconVivo,
  IconFolderOpen
} from '../icons'

export interface GalleryContextMenuActions {
  onOpen: (file: MediaFile) => void
  onEdit: (file: MediaFile) => void
  onSaveAs: (file: MediaFile) => void
  onExport: (file: MediaFile) => void
  onCopy: (file: MediaFile) => void
  onMove: (file: MediaFile) => void
  onRename: (file: MediaFile) => void
  onToggleFavorite: (file: MediaFile) => void
  onDelete: (file: MediaFile) => void
  onDeletePermanent: (file: MediaFile) => void
  onShowProperties: (file: MediaFile) => void
  onSelectAllInCategory?: () => void
  // 打开文件所在目录（在资源管理器中选中）
  onOpenLocation?: (file: MediaFile) => void
  // T09：剪贴板分享（单文件）
  onShare?: (file: MediaFile, channelId: ShareChannelId) => void
}

// U7：改为函数工厂，避免模块级 React elements 在模块加载时创建且被所有调用共享
// 每次调用 getContextMenuItems 时创建新的 icon 元素，避免潜在的复用问题
function createIcons() {
  return {
    open: <IconOpen size={16} />,
    edit: <IconEdit size={16} />,
    saveAs: <IconSaveAs size={16} />,
    export: <IconExport size={16} />,
    copy: <IconCopy size={16} />,
    move: <IconMove size={16} />,
    rename: <IconRename size={16} />,
    favorite: (isFavorite: boolean) => <IconFavorite size={16} filled={isFavorite} />,
    delete: <IconDelete size={16} />,
    properties: <IconProperties size={16} />,
    folderOpen: <IconFolderOpen size={16} />,
    share: <IconShare size={16} />,
    wechat: <IconWeChat size={16} />,
    qq: <IconQQ size={16} />,
    vivo: <IconVivo size={16} />,
    selectAll: <IconSelectAll size={16} />
  }
}

export function getContextMenuItems(
  file: MediaFile,
  actions: GalleryContextMenuActions,
  t: TFunction
): ContextMenuItem[] {
  const icons = createIcons()
  return [
    {
      id: 'open',
      label: t('gallery.contextMenu.open'),
      icon: icons.open,
      onClick: () => actions.onOpen(file)
    },
    {
      id: 'edit',
      label: t('gallery.contextMenu.edit'),
      icon: icons.edit,
      disabled: file.file_type === 'video',
      onClick: () => actions.onEdit(file)
    },
    {
      id: 'openLocation',
      label: t('gallery.contextMenu.openLocation'),
      icon: icons.folderOpen,
      onClick: () => actions.onOpenLocation?.(file)
    },
    { id: 'divider-1', label: '', divider: true },
    {
      id: 'saveAs',
      label: t('gallery.contextMenu.saveAs'),
      icon: icons.saveAs,
      onClick: () => actions.onSaveAs(file)
    },
    {
      id: 'export',
      label: t('gallery.contextMenu.export'),
      icon: icons.export,
      onClick: () => actions.onExport(file)
    },
    {
      id: 'copy',
      label: t('gallery.contextMenu.copyTo'),
      icon: icons.copy,
      onClick: () => actions.onCopy(file)
    },
    {
      id: 'move',
      label: t('gallery.contextMenu.moveTo'),
      icon: icons.move,
      onClick: () => actions.onMove(file)
    },
    {
      id: 'rename',
      label: t('gallery.contextMenu.rename'),
      icon: icons.rename,
      onClick: () => actions.onRename(file)
    },
    // T09：分享二级子菜单（微信 / QQ / vivo办公套件）
    ...(actions.onShare
      ? [
          {
            id: 'share',
            label: t('gallery.contextMenu.share'),
            icon: icons.share,
            onClick: () => {},
            submenu: [
              {
                id: 'share-wechat',
                label: t('gallery.contextMenu.shareToWechat'),
                icon: icons.wechat,
                onClick: () => actions.onShare!(file, 'wechat')
              },
              {
                id: 'share-qq',
                label: t('gallery.contextMenu.shareToQQ'),
                icon: icons.qq,
                onClick: () => actions.onShare!(file, 'qq')
              },
              {
                id: 'share-vivo',
                label: t('gallery.contextMenu.shareToVivo'),
                icon: icons.vivo,
                onClick: () => actions.onShare!(file, 'vivo')
              }
            ]
          }
        ]
      : []),
    { id: 'divider-2', label: '', divider: true },
    {
      id: 'favorite',
      label: file.is_favorite
        ? t('gallery.contextMenu.unfavorite')
        : t('gallery.contextMenu.favorite'),
      icon: icons.favorite(file.is_favorite),
      onClick: () => actions.onToggleFavorite(file)
    },
    {
      id: 'delete',
      label: t('gallery.contextMenu.delete'),
      danger: true,
      icon: icons.delete,
      onClick: () => actions.onDelete(file)
    },
    {
      id: 'deletePermanent',
      label: t('gallery.contextMenu.deletePermanent'),
      danger: true,
      icon: icons.delete,
      onClick: () => actions.onDeletePermanent(file)
    },
    { id: 'divider-3', label: '', divider: true },
    {
      id: 'selectAllInCategory',
      label: t('gallery.contextMenu.selectAllInCategory'),
      icon: icons.selectAll,
      onClick: () => actions.onSelectAllInCategory?.()
    },
    {
      id: 'properties',
      label: t('gallery.contextMenu.properties'),
      icon: icons.properties,
      onClick: () => actions.onShowProperties(file)
    }
  ]
}
