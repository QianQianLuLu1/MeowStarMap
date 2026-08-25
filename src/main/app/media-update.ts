import type { AppContext } from './app-context'
import { sendToRenderer } from './renderer-bridge'
import { MediaRepository } from '../database/media-repository'
import { ImportRootRepository } from '../database/import-root-repository'
import { pathGuard } from '../ipc/validator'

// 待确认#6：media:updated 广播节流
// 高频单条更新（如连续评分、标签编辑）会触发多次全量广播，渲染层重载数据
// 节流为 100ms 内仅广播一次，失效缓存立即执行，广播延迟合并
const MEDIA_UPDATE_THROTTLE_MS = 100

/**
 * 从数据库 + 用户设置刷新 pathGuard 的媒体根目录白名单。
 *
 * 数据源（与 media:// 协议白名单 isMediaPathAllowed 保持一致）：
 * 1. media_files.source_path（扫描根目录，worker-entry.ts 中 source_path = rootPath）
 * 2. app_settings.customScanPaths（用户配置的自定义扫描路径，即便尚未扫描也允许读写）
 * 3. import_roots（导入向导复制的目标目录；扫描 worker 写入 source_path 前的时间窗内，
 *    若不放行，media:// 协议会拒绝读取导入目录，缩略图加载失败导致图库卡片"看似空"）
 *
 * 调用时机：启动初始化 + 每次 notifyMediaUpdated（媒体变更收口点）。
 * 幂等：pathGuard.register 内部用 Set 去重，重复注册无副作用。
 *
 * 信任前提（改动前务必先看）：本函数是白名单的**恢复**机制，重启后 roots 为空，
 * 全靠这些数据源把非主目录盘的媒体根重新装回去，因此这里不能再用 isAllowed 过滤
 * （那样会把 D:\Games 之类的合法根挡在门外，媒体直接读不出来）。
 * 安全性由写入端保证——所有能写这些数据源的入口都必须先过读校验：
 * - media_files.source_path ← scanner:start（assertScanPathsAllowed）/ 主进程启动扫描
 * - app_settings.customScanPaths ← settings:set（assertCustomScanPaths）
 * - import_roots ← import:run（assertFileReadPath / assertFileWritePath 校验 targetBaseDir）
 * 新增写入口时同样要先校验，否则等于绕过 pathGuard 自助扩权。
 */
export function refreshPathGuardRoots(ctx: AppContext): void {
  const db = ctx.dbManager.getDatabase()
  if (!db) return

  const roots: string[] = []

  // 1. 已索引媒体的扫描根目录
  try {
    const rows = db
      .prepare(
        'SELECT DISTINCT source_path FROM media_files WHERE source_path IS NOT NULL AND source_path != ""'
      )
      .all() as Array<{ source_path: string }>
    for (const r of rows) roots.push(r.source_path)
  } catch {
    // 表结构异常时静默，userHome/userDataDir 仍兜底
  }

  // 2. 用户配置的自定义扫描路径（未扫描也放行，供导入/写入使用）
  try {
    const customPaths = ctx.dbManager.getSetting<string[]>('customScanPaths', [])
    if (Array.isArray(customPaths)) roots.push(...customPaths)
  } catch {
    // 设置读取失败忽略
  }

  // 3. 已登记导入根：扫描 worker 把 source_path 写入 media_files 之前存在时间窗，
  //    此窗口内不放行导入目录，media:// 会拒绝读取，缩略图加载失败
  try {
    const importRoots = new ImportRootRepository(db).listImportRoots()
    roots.push(...importRoots)
  } catch {
    // import_roots 表缺失或读取失败时静默，与上方数据源容错一致
  }

  pathGuard.registerRoots(roots)
}

/**
 * 媒体数据变更通知：失效白名单缓存 + 刷新 media_count 缓存 + 节流广播 media:updated。
 * 通过 AppContext 上的回调调用，避免模块反向依赖 Application。
 */
export function notifyMediaUpdated(ctx: AppContext): void {
  // 失效 media:// 协议白名单缓存，确保新增/删除/移动的文件能被正确识别（立即执行）
  ctx.invalidateMediaPathCache()

  // 广播与昂贵刷新统一节流：100ms 内合并为一次，避免每次单条操作都触发
  // SELECT DISTINCT source_path 与 COUNT(*) 全表查询
  if (ctx.getMediaUpdateTimer()) return
  ctx.setMediaUpdateTimer(
    setTimeout(() => {
      ctx.setMediaUpdateTimer(null)
      // 同步刷新 pathGuard 媒体根目录白名单，保持与 DB 一致
      // 扫描/导入/移动/删除后可能新增 source_path，需重新注册
      // pathGuard 白名单极少变化，无需每次操作重建，故并入节流
      refreshPathGuardRoots(ctx)
      // A-S4：同步更新 media_count 缓存（仅缓存未删除记录数，用于 media:list 分页 total）
      // Slice 7c-fix：写入逻辑收口到 MediaRepository.refreshMediaCountCache，消除双写路径
      // 数据库写操作进程拆分：refreshMediaCountCache 改为 async（写操作走 worker 进程）
      // 此处 fire-and-forget：notifyMediaUpdated 是同步 void 方法，不能 await；缓存更新失败不影响主流程
      // R5：刷新失败时显式调用 markMediaCountStale 标记缓存过期，下次 listMedia 检测到 stale=1
      // 走真实 COUNT 并重建缓存；不再静默吞错让 total 长期陈旧
      try {
        const db = ctx.dbManager.getDatabase()
        if (db) {
          const repo = new MediaRepository(
            db,
            ctx.dbManager.getWorkerBridge(),
            ctx.dbManager.getDbPath()
          )
          void repo.refreshMediaCountCache().catch(() => {
            // 刷新失败：标记缓存失效，下次读取回退到真实 COUNT
            void repo.markMediaCountStale().catch(() => {
              // stale 标记写入也失败（worker 持续故障）：维持现状，下次 listMedia 仍走缓存
              // 接受这一最坏情况——DB 写入完全不可用时缓存陈旧是次要问题
            })
          })
        }
      } catch {
        // 缓存更新失败不影响主流程，media:list 会回退到实时 COUNT
      }
      sendToRenderer(ctx, 'media:updated')
    }, MEDIA_UPDATE_THROTTLE_MS)
  )
}
