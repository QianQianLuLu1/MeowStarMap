/**
 * 本次运行标识（bootId）单一真相源——零依赖叶子模块
 *
 * 依赖声明：仅 node:crypto（randomUUID），零项目依赖，可被 logger/exit-forensics 等任意早期模块导入
 * 启动说明：无需初始化；模块加载期生成一次，进程生命周期内恒定
 * 错误处理：randomUUID 由宿主保证可用；无失败分支（fail-open 语义天然成立）
 * 参数校验：无入参
 * 基础测试用例：boot-id.test.ts（UUID 格式 / 短码长度 / 单例稳定）
 *
 * 背景：exit-forensics 的 bootId 在 app.whenReady 后才生成，而 logger 可被更早懒初始化，
 * 两者各自生成会导致主日志行与 heartbeat/last-exit 的 bootId 对不上、时间线无法拼接。
 * 本模块在模块加载期生成，供两侧共同 import。
 */
import { randomUUID } from 'crypto'

/** 本次运行的完整 UUID（heartbeat.json / last-exit.json / manifest.json 共用） */
export const BOOT_ID = randomUUID()

/** 短码（前 8 位）：主日志行内嵌用，控制行宽 */
export const BOOT_ID_SHORT = BOOT_ID.slice(0, 8)
