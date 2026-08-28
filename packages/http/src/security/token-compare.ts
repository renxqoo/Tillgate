/**
 * 常量时间令牌比较：鉴权令牌/签名校验不得泄露前缀匹配进度。
 */
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

export function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    nodeTimingSafeEqual(bufA, bufA); // 保持与等长路径相近耗时
    return false;
  }
  return nodeTimingSafeEqual(bufA, bufB);
}
