/**
 * 凭据持久化 port(标识绑定 + 密码行)。每动词 db: DbLike 首参参与调用方事务
 * (总纲 §5.4);行投影不含秘密列。实现见 adapters/postgres/credentials.ts、
 * passwords.ts;内存替身见 testing/in-memory-identity-store.ts。
 */
import type { DbLike } from '@tokenlens/db';
import type { NormalizedIdentifier } from '../domain/identifier.js';

export type RegisterCredentialOutcome =
  | { readonly status: 'created'; readonly credentialId: number }
  | { readonly status: 'replay'; readonly credentialId: number }
  | { readonly status: 'taken' };

export interface CredentialStore {
  /**
   * 绑定标识(advisoryLock `identity.user:{userId}` 临界区内 insert onConflictDoNothing
   * + 读回分类):created = 新落行;replay = 同用户重挂(幂等);taken = 他人占用。
   */
  registerCredential(
    db: DbLike,
    input: { userId: number; identifier: NormalizedIdentifier },
  ): Promise<RegisterCredentialOutcome>;

  /** 首密码行(仅 registerCredential created 分支;SQL now()) */
  upsertPassword(db: DbLike, input: { userId: number; passwordHash: string }): Promise<void>;

  /** 标识 → (userId, passwordHash) | null(authenticate join 查询) */
  findPasswordHashByIdentifier(
    db: DbLike,
    input: NormalizedIdentifier,
  ): Promise<{ userId: number; passwordHash: string } | null>;

  /** 读取存储哈希(B04:调用方在锁内临界区读→验→改) */
  loadPasswordHash(db: DbLike, userId: number): Promise<string | null>;

  /** 换哈希(SQL now();行消失 = Defect) */
  updatePassword(db: DbLike, input: { userId: number; passwordHash: string }): Promise<boolean>;

  /** 重置/设初始密码(upsert;SQL now()) */
  resetPassword(db: DbLike, input: { userId: number; passwordHash: string }): Promise<void>;

  /** userId 的可投递标识(email 优先、phone 次之,确定性排序) */
  findDeliveryIdentifier(
    db: DbLike,
    userId: number,
  ): Promise<{ kind: 'email' | 'phone'; value: string } | null>;

  /** 是否存在密码行(解绑最后凭据守卫) */
  hasPassword(db: DbLike, userId: number): Promise<boolean>;
}
