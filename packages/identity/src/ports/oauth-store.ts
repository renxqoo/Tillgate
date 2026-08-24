/**
 * OAuth 绑定持久化 port。实现见 adapters/postgres/oauth.ts。
 * (provider, subject) 全局唯一 = 防劫持;(userId, provider) 单绑定。
 */
import type { DbLike } from '@tillgate/db';

export type LinkOutcome =
  | { readonly status: 'linked'; readonly linkId: number }
  | { readonly status: 'replay'; readonly linkId: number }
  | { readonly status: 'provider_identity_taken' }
  | { readonly status: 'user_already_linked' };

export type UnlinkOutcome =
  | { readonly status: 'unlinked'; readonly linkId: number }
  | { readonly status: 'not_found' }
  | { readonly status: 'last_credential' };

export interface OAuthStore {
  /** (provider, subject) → userId | null */
  findUser(db: DbLike, input: { provider: string; subject: string }): Promise<number | null>;

  /**
   * 绑定(insert onConflictDoNothing 双索引兜底 + 读回分类)。
   * 契约:调用方持 `identity.user:{userId}` advisoryLock。
   */
  link(
    db: DbLike,
    input: { userId: number; provider: string; subject: string; email: string | null },
  ): Promise<LinkOutcome>;

  /**
   * 解绑(for update + 凭据集守卫:密码或 ≥2 绑定才允许——删后必须仍留登录方式)。
   * 契约:调用方持锁(「删后仍留登录方式」的判定在临界区内完成)。
   */
  unlink(db: DbLike, input: { userId: number; provider: string }): Promise<UnlinkOutcome>;
}
