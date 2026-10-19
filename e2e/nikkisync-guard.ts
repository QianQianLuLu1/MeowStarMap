/**
 * e2e NikkiSync 环境判据：把「未建链」与「已建链后的真实缺陷」分开。
 *
 * 为什么需要它：`npm install` 会剪掉 `node_modules/@nikkisync/*` junction（它们不是声明
 * 依赖），此时 `hasNikkiSyncLink()` 为 false，`runtime-manager.start()` 直接把状态置为
 * `unavailable` 并给出 `linkMissingHint`。按 `src/main/nikkisync/AGENTS.md` §6，未链接是
 * **受支持的默认态**：装载类测试整件 skip，不得把环境缺失伪装成逻辑失败。而
 * `e2e/nikkisync-runtime.e2e.ts` 的 N 套件此前没有这道门控，于是每次装完依赖都会以
 * 「启动链没跑或抛错逃逸」这种与实际原因相反的文案报红。
 *
 * 与 `e2e/dist-guard.ts` 同一形态：本模块只做判定、不做修复，判据全在纯函数里，可单测。
 * 详见 docs/plans/2026-10-19-fix-e2e-smoke-nikkisync-links.md。
 */

/** 门控入参：`hasNikkiSyncLink(projectRoot)` 的读数。 */
export interface NikkiSyncGateInput {
  /** 四条 `@nikkisync/*` 包内 `package.json` 是否都可解析（不用目录存在判定，悬空 junction 会误报） */
  linked: boolean
}

export interface NikkiSyncGateDecision {
  /** `skip` = 环境未建链；`run` = 环境合格，任何异常都是真实缺陷 */
  action: 'run' | 'skip'
  /** skip 时必须给出可直接执行的修复命令；run 时作为留档说明 */
  reason: string
}

/**
 * 纯函数：由链接现状决定 N 套件是否执行。
 *
 * 判据刻意只取 `linked` 一项：已建链时 `state=unavailable` 属于装载面缺陷，必须继续断言，
 * 不在此处降级为 skip（否则会把真实回归藏进 skip）。
 */
export function decideNikkiSyncGate(input: NikkiSyncGateInput): NikkiSyncGateDecision {
  if (input.linked) {
    return {
      action: 'run',
      reason: '@nikkisync 链接就绪：N 套件按原断言执行'
    }
  }
  return {
    action: 'skip',
    reason:
      '未建链：node_modules/@nikkisync/* junction 缺失（npm install 会剪掉它们，它们不是声明依赖）。' +
      '未链接是受支持的默认态，本轮不据此判红。修复：npm run link:nikkisync，' +
      '再用 npm run verify:nikkisync 复验，然后重跑本套件。'
  }
}

/** 断言文案要携带的运行时读数（来自 `runtime-manager.status()`）。 */
export interface NikkiSyncStateReadout {
  state: string
  linkReady: boolean
  /** 未建链时 `runtime-manager` 给出的可执行指引；已建链时通常缺省 */
  hint?: string
}

/**
 * 纯函数：把状态读数压成单行文本，供 e2e 断言失败信息直接携带。
 *
 * 目的是消除「文案与实际原因相反」：缺省字段一律打占位符，绝不拼出 `undefined` 字样。
 */
export function formatNikkiSyncStateDiagnostic(input: NikkiSyncStateReadout): string {
  const state = typeof input.state === 'string' && input.state.length > 0 ? input.state : '<none>'
  const hint = typeof input.hint === 'string' && input.hint.length > 0 ? input.hint : 'none'
  return `state=${state} linkReady=${String(Boolean(input.linkReady))} hint=${hint}`
}

/**
 * 上游默认库文件（`%LOCALAPPDATA%/NikkiSync/nikkisync.sqlite`）的一次读数快照。
 * 不存在时统一记 `{ exists: false, mtimeMs: 0, sizeBytes: 0 }`，让「缺失」也成为一个可比较的值。
 */
export interface DbSnapshot {
  exists: boolean
  mtimeMs: number
  sizeBytes: number
}

/** 入参把关：判据函数不猜，非法读数直接抛错，绝不把 `undefined` 当成「未触碰」。 */
function assertSnapshot(value: unknown, label: string): DbSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`isUpstreamDbTouched: ${label} 必须是 DbSnapshot 对象`)
  }
  const { exists, mtimeMs, sizeBytes } = value as Partial<DbSnapshot>
  if (typeof exists !== 'boolean' || typeof mtimeMs !== 'number' || typeof sizeBytes !== 'number') {
    throw new TypeError(`isUpstreamDbTouched: ${label} 的 exists/mtimeMs/sizeBytes 类型不符`)
  }
  // typeof 已排除 undefined，这里只需再挡掉 NaN / Infinity
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(sizeBytes)) {
    throw new TypeError(`isUpstreamDbTouched: ${label} 的 mtimeMs/sizeBytes 必须是有限数`)
  }
  return { exists, mtimeMs, sizeBytes }
}

/**
 * 纯函数：本次运行是否改动了上游默认库。
 *
 * 为什么用它替代旧判据：N2 原本断言该文件「必须不存在」，但本机 `%LOCALAPPDATA%\NikkiSync\
 * nikkisync.sqlite` 由独立 NikkiSync exe 长期写入且合法存在，于是嵌入态明明没越界也恒判红。
 * 判据改为「运行前后读数不变」，原意（嵌入态绝不写上游默认数据目录，见
 * `src/main/nikkisync/AGENTS.md` 硬性约定 §3）不但保留而且更强——文件被删除同样算触碰。
 */
export function isUpstreamDbTouched(before: DbSnapshot, after: DbSnapshot): boolean {
  const b = assertSnapshot(before, 'before')
  const a = assertSnapshot(after, 'after')
  if (!b.exists && !a.exists) return false
  if (b.exists !== a.exists) return true
  return b.mtimeMs !== a.mtimeMs || b.sizeBytes !== a.sizeBytes
}
