/**
 * 视频编辑任务类型定义
 *
 * 单视频编辑与批量编辑共用 VideoEditTask 结构；
 * 调色参数复用图片编辑器 FilterParams，水印参数复用 WatermarkConfig。
 *
 * 单一来源已上移至 shared（preload 桥接层同样引用），此处 re-export
 * 保持 worker-protocol / bridge 等既有导入路径稳定。
 *
 * 详见 docs/VIDEO_EDIT_PLAN.md §6.2。
 */
export type {
  VideoEditTask,
  VideoEditRequest,
  VideoEditResponse,
  VideoEditBatchRequest,
  VideoEditBatchResponse
} from '../../shared/types/electron-api'
