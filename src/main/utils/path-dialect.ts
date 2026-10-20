/**
 * 路径语义「方言」选择器（比较层 / IO 层之外的第三类：混合输入）。
 *
 * 背景：产品只发布 Windows x64，但 CI 的 test / coverage job 在 ubuntu-latest 跑单测。
 * 凡是拿**宿主** `path` 绑定去解释「库内 / 注册表 / 游戏配置里的 Windows 形态路径串」的地方，
 * 两侧结论随宿主漂移：`posix.dirname('D:\\a\\b')` 返回 `'.'`、`posix.join('C:\\a','b')`
 * 造出 `C:\\a/b` 混合分隔符、`posix.sep` 让 `startsWith(root + sep)` 永不命中。
 *
 * 本仓口径三档：
 * 1. 串只用作**键或比较**（前缀判定、Set 成员、大小写折叠）⇒ 直接钉 `path.win32`
 *    （样板：`src/main/utils/ipc-validate.ts`、`src/main/ipc/validator.ts`）。
 * 2. 串**交给真实 fs / child_process / dialog** ⇒ 保持宿主绑定。
 * 3. 同一函数两侧都会收到（既可能是库里的 `D:\Game`，也可能是 `os.tmpdir()` 遍历出的
 *    `/tmp/xxx`）⇒ 用本模块按**数据方言**逐次选语义，不能整体钉死也不能整体放开。
 *
 * 判据是「串长什么样」，不是 `process.platform`——后者正是本轮要消灭的反模式。
 * 已知判据域：本仓这三类调用方的路径只有上述两种来源（Windows 形态数据串 vs 真实遍历串），
 * 而 POSIX 文件名里出现裸反斜杠的情况不在其中；`path.posix.win32 === path.win32`，
 * 故取到的 win32 实例与宿主无关，测试可在任意宿主复现另一侧行为。
 */
import nodePath from 'path'

/** Windows 形态判据：含反斜杠（`D:\a`、`\\srv\share`），或「盘符 + 分隔符」开头（`C:/a`）。 */
const WINDOWS_SHAPED = /^[A-Za-z]:[\\/]|\\/

/**
 * 按串的数据方言选路径语义实现。
 *
 * 两侧都取**显式**方言（win32 / posix），不读宿主绑定：这样结论与宿主无关，
 * 「开发机绿 + 装置绿」才可推断 CI 绿。IO 层安全性：
 * - POSIX 形态串只在 Linux/CI 上来自真实遍历（Windows 的 `mkdtemp`/`__dirname` 恒为反斜杠形态），
 *   此时宿主语义本就是 posix，取 `posix` 与取宿主逐字等价；
 * - 万一在 Windows 上收到 POSIX 形态串，Windows 的文件 API 同样接受 `/` 分隔符，
 *   交给 `fs` 仍可解析，只是形态保持正斜杠——这正是 CI 上看到的形态。
 */
export function pathOf(p: string): typeof nodePath {
  return WINDOWS_SHAPED.test(p) ? nodePath.win32 : nodePath.posix
}

/** 该方言的分隔符：前缀比较（`startsWith(root + sep)`）必须用它，而不是宿主 `path.sep`。 */
export function sepOf(p: string): string {
  return pathOf(p).sep
}

/**
 * 以 `base` 的方言拼接纯名字片段。
 * 片段一律不得自带分隔符（`'X6Game'` 而非 `'X6Game\\Saved'`），否则正斜杠根会拼出混合串。
 */
export function joinUnder(base: string, ...segments: string[]): string {
  return pathOf(base).join(base, ...segments)
}
