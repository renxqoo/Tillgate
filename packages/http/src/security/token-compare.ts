/**
 * 常量时间令牌比较：鉴权令牌/签名校验不得泄露前缀匹配进度。
 * v1 两处同语义漂移拷贝（trace-receiver/token-compare.ts 与 http 侧比较件）合一——
 * observability IMPLEMENTATION §7 挂账#3 的裁决落点；worker 健康令牌、client-api
 * webhook 签名比较（P5 波次）自此同源消费。
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
