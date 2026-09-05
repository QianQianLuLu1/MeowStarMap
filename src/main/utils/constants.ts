/**
 * 主进程全局命名常量
 *
 * 解决 C-G3：原先魔法数字遍布 index.ts、scanner/index.ts、video-service.ts 等文件，
 * 如 1500（启动扫描延迟）、4（缩略图并发）、67/90（驱动器字母 C-Z）等。
 *
 * 本模块集中主进程跨文件共享的常量；文件内局部常量（如 video-service 的超时）
 * 仍在各自文件定义以保持内聚。
 */

/** 启动自动扫描延迟（毫秒），等待窗口 ready-to-show 后再开始 */
// 启动性能优化（docs/archive/plans/startup-perf.md 方案 A）：1500 → 5000，
// 把自动扫描 + 链式缩略图/pHash/场景分析推迟到窗口出现 5s 后，缓解冷启动负担
// （LRU +5000 / 崩溃清理 +6000 / 自动更新 +8000 的梯度随之整体后移）
export const STARTUP_SCAN_DELAY_MS = 5000

/** 缩略图批量生成并发数（控制 sharp/ffmpeg 并发，避免 OOM） */
export const THUMBNAIL_CONCURRENCY = 4

/** 扫描驱动器字母范围：C(67) 到 Z(90) */
export const DRIVE_LETTER_START = 67 // 'C'
export const DRIVE_LETTER_END = 90 // 'Z'

/** media:// 协议白名单缓存 TTL（毫秒） */
export const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000

/** 单次扫描路径数组上限（防止渲染进程传入超大数组） */
export const MAX_PATH_ARRAY_SIZE = 1000

/** 单次 mediaId 数组上限 */
export const MAX_MEDIA_ID_ARRAY_SIZE = 1000

/** 单个标签名称最大长度 */
export const MAX_TAG_NAME_LENGTH = 64

/** 文件路径字符串最大长度 */
export const MAX_FILE_PATH_LENGTH = 1024

/**
 * 缩略图 LRU 元数据持久化文件名。
 * FIX(组19-1): 从 thumbnail/generator.ts 迁出到本叶子常量模块——启动清理
 * （startup-tasks.cleanupOrphanThumbnails）需要豁免该文件，直接 import generator
 * 会连带加载 sharp/ffmpeg 等重依赖；常量集中在此供两侧共享，避免名称漂移。
 */
export const CACHE_METADATA_FILENAME = 'cache-metadata.json'
