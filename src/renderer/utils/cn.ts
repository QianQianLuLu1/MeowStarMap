/**
 * 轻量 className 合并工具（零依赖）
 *
 * 过滤假值后以空格拼接。条件类名在调用处用三元 / && 表达式表达：
 *   cn('glass-card', isActive && 'active', className)
 *
 * 不引入 tailwind-merge：项目类名冲突场景由约定规避
 * （自定义类与 Tailwind 工具类不竞争同一属性），保持依赖面最小。
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
