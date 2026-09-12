/**
 * 安全极值工具：基于单趟遍历（for...of）求最大/最小值，
 * 规避 `Math.max(...arr)` / `Math.min(...arr)` 将超大数组展开为函数实参、
 * 超出 V8 调用栈参数上限而抛 `RangeError: Maximum call stack size exceeded` 的反模式。
 *
 * 相比 `Math.min(...arr.map(fn))`，本工具省去中间 `.map` 临时数组，空间 O(1)。
 */

/** 返回 values 经 selector 映射后的最大值；空集合返回 initial（默认 -Infinity）。 */
export function maxOf<T>(
  values: Iterable<T>,
  selector: (value: T) => number,
  initial = -Infinity
): number {
  let max = initial
  for (const value of values) {
    const n = selector(value)
    if (n > max) max = n
  }
  return max
}

/** 返回 values 经 selector 映射后的最小值；空集合返回 initial（默认 Infinity）。 */
export function minOf<T>(
  values: Iterable<T>,
  selector: (value: T) => number,
  initial = Infinity
): number {
  let min = initial
  for (const value of values) {
    const n = selector(value)
    if (n < min) min = n
  }
  return min
}
