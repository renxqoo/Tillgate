/**
 * 测试内替代非空断言 `x!` 的统一收窄手段：
 * 值缺失时抛出带定位信息的错误，而非对编译器拍胸脯。
 */
export function defined<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}
