/**
 * jti 黑名单 port(登出/单会话强制下线)。键存活至令牌自然过期,无需 GC。
 * 故障口径:revoke 写失败上抛(调用方映射 unavailable,幂等重试);
 * isRevoked 读失败 fail-open + warn——吊销是增强层,主防线是属主回查与锚点线,
 * Redis 抖动不应把全站会话打成不可用(可用性取舍)。
 * 实现见 adapters/redis/revocation-store.ts。
 */
export interface SessionRevocationStore {
  revoke(jti: string, remainingTtlSec: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}
