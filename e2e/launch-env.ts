/**
 * 交给 Electron 子进程的环境变量闸门（纯函数，无 IO / 无 electron 依赖）。
 *
 * 为什么需要它：宿主 shell 可能导出 `ELECTRON_RUN_AS_NODE`（本机实测由 Qoder 桌面端注入，
 * 与 `QODER_*`、`ELECTRON_MIRROR` 同批存在，任何 shell profile 里都没有）。带该变量时，
 * 被启动的打包 exe 不走 Electron，而是退化成**纯 Node 解释器**，把 Playwright 追加的
 * Chromium 开关（`--inspect=0` / `--remote-debugging-port=0` / `--user-data-dir=…`）判为
 * `bad option`，`exitCode=9` 直接退出 ⇒ 冒烟套件整批倒在 launch 之前，且没有一条是断言失败，
 * 症状与产品回归完全一致。
 *
 * 判据只能落在「我们交给子进程的那份 env」上：运行者的 shell 不可控，也不该要求跑测试的人
 * 手工 `unset`——那等于让本仓 e2e 只在某一类终端上可用。剥掉它之后，同一条命令在宿主
 * 集成终端、系统终端与 CI 上语义一致。
 */

/** 会被宿主泄漏、使 Electron 退化成 Node 解释器的环境变量名 */
export const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/**
 * 返回去掉 `ELECTRON_RUN_AS_NODE` 的副本；入参不被修改，键本就不存在时原样返回入参。
 *
 * 不看值：Electron 侧的判定是「该变量是否存在」，空串同样会让 exe 走 Node 分支。
 * 类型用 `Record<string, string>` 而非 `NodeJS.ProcessEnv`：后者值域含 `undefined`，
 * 而 `_electron.launch({ env })` 只收字符串值域，用前者才不会把 `undefined` 带进子进程。
 */
export function sanitizeLaunchEnv(env: Record<string, string>): Record<string, string> {
  if (!(ELECTRON_RUN_AS_NODE in env)) {
    return env
  }
  const next = { ...env }
  delete next[ELECTRON_RUN_AS_NODE]
  return next
}
