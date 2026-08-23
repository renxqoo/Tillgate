/**
 * OAuth state 单次存储 port(多副本共享 + 重启不丢;Redis 形态)。
 * consume 即删(单次);save/consume 失败由 application 翻译为 unavailable
 * (不发带不上单次 state 的授权跳转——fail-closed,v1 语义)。
 * 实现见 adapters/redis/oauth-state-store.ts。
 */
export interface OAuthStatePayload {
  readonly provider: string;
  readonly next?: string;
}

export interface OAuthStateStore {
  save(state: string, payload: OAuthStatePayload, ttlSec: number): Promise<void>;
  consume(state: string): Promise<OAuthStatePayload | null>;
}
