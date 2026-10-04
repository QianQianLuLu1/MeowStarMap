// 格式检查作用域解析（供 scripts/verify-changes.ts 使用）
//
// 作用：把 package.json 中 `lint-staged` 的键（micromatch 风格 glob）解析成"钩子会跑
// prettier 的范围"，让只读的格式检查与实际提交闸门保持同一口径——钩子不格式化的路径
// （如 docs/**、.qoder/**、scripts/AGENTS.md）也不会在这里被判失败。
//
// 设计取舍：不引入 micromatch / picomatch 依赖，只解析仓库实际使用的四种键形态：
//   目录作用域 + 花括号多扩展名 / 目录作用域 + 单扩展名 / 根作用域花括号 / 根作用域单扩展名
// 遇到无法解析的键返回 null，由调用方输出 ⚠ 告警（宁可显式提示，不做静默猜测）；
// scripts/__tests__/verify-format-scope.test.ts 中的配置契约测试会在键形态漂移时先失败。
//
// 铁律：本模块为纯函数，只读，绝不 writeFile 改动任何源码文件。
// 注意：本文件注释不得使用块注释书写 glob 示例，`**` 与 `/` 相邻会提前终止注释。

export interface FormatScopeRule {
  /** 目录前缀（posix 风格）；null 表示仅匹配仓库根一层的文件 */
  dir: string | null
  /** 允许的扩展名（不含点，小写） */
  exts: string[]
}

// 目录作用域：`<dir>/**/*.{a,b}` 或 `<dir>/**/*.a`；dir 允许多级与以点开头的目录名
const DIR_SCOPED = /^([^/]*(?:\/[^/]+)*)\/\*\*\/\*\.(?:\{([A-Za-z0-9,]+)\}|([A-Za-z0-9]+))$/
// 根作用域：`*.{a,b}` 或 `*.a`（键中不含 `/`，故只匹配仓库根一层）
const ROOT_SCOPED = /^\*\.(?:\{([A-Za-z0-9,]+)\}|([A-Za-z0-9]+))$/

function splitExts(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 解析单个 lint-staged 键为格式作用域规则。
 * @returns 规则；键形态不受支持（否定 glob、无 glob 的字面路径、未闭合花括号等）时返回 null
 */
export function parseFormatScopeKey(key: string): FormatScopeRule | null {
  if (typeof key !== 'string') return null
  const k = key.trim()
  // 否定 glob（形如 `!src/...`）语义为"排除"，本模块不支持，交给调用方告警
  if (!k || k.startsWith('!')) return null

  const dirScoped = DIR_SCOPED.exec(k)
  if (dirScoped) {
    return { dir: dirScoped[1], exts: splitExts(dirScoped[2] ?? dirScoped[3]) }
  }

  const rootScoped = ROOT_SCOPED.exec(k)
  if (rootScoped) {
    return { dir: null, exts: splitExts(rootScoped[1] ?? rootScoped[2]) }
  }

  return null
}

function toTaskList(tasks: string | string[] | undefined): string[] {
  if (typeof tasks === 'string') return [tasks]
  return Array.isArray(tasks) ? tasks : []
}

/**
 * 从 lint-staged 配置中筛出"任务里含 prettier 命令"的键，保持配置声明顺序。
 * 这些键定义的范围 = 钩子会格式化（改写）的文件范围。
 */
export function getPrettierKeys(lintStaged: Record<string, string | string[]>): string[] {
  if (!lintStaged || typeof lintStaged !== 'object') return []
  return Object.keys(lintStaged).filter((key) =>
    toTaskList(lintStaged[key]).some(
      (task) => typeof task === 'string' && task.trim().startsWith('prettier')
    )
  )
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

function matchesRule(rule: FormatScopeRule, file: string): boolean {
  const dot = file.lastIndexOf('.')
  if (dot < 0) return false
  const ext = file.slice(dot + 1).toLowerCase()
  if (!rule.exts.includes(ext)) return false
  // 根作用域键（dir 为 null）等价于 lint-staged 中不含斜杠的 glob，只匹配仓库根一层
  if (rule.dir === null) return !file.includes('/')
  return file.startsWith(`${rule.dir}/`)
}

/**
 * 从变更文件列表中挑出落在钩子格式化范围内的文件。
 * 输入兼容 Windows 反斜杠路径；输出为归一化后的 posix 相对路径，去重且保持输入顺序。
 */
export function selectFormatTargets(files: string[], keys: string[]): string[] {
  const rules = keys
    .map(parseFormatScopeKey)
    .filter((rule): rule is FormatScopeRule => rule !== null)
  if (rules.length === 0 || !Array.isArray(files)) return []

  const seen = new Set<string>()
  const targets: string[] = []
  for (const file of files) {
    if (typeof file !== 'string' || !file) continue
    const normalized = toPosix(file)
    if (seen.has(normalized)) continue
    if (rules.some((rule) => matchesRule(rule, normalized))) {
      seen.add(normalized)
      targets.push(normalized)
    }
  }
  return targets
}
