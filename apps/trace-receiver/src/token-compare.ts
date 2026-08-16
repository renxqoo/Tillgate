import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/**
 * 常量时间字符串比较（鉴权令牌）：长度差异先以哑比较抹平耗时，
 * 再做字节级比较——令牌校验不得泄露前缀匹配进度。
 * （与 packages/http/csrf.ts tokenEquals 同语义；独立实现避免为单个
 * 函数引入 web 共享层依赖。）
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    nodeTimingSafeEqual(bufA, bufA); // 保持与等长路径相近耗时
    return false;
  }
  return nodeTimingSafeEqual(bufA, bufB);
}
