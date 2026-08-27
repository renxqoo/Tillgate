/**
 * 网关鉴权读模型:单查询取回鉴权与限额全集,
 * 守卫 = key status=0 + 属主 status=0 + 未过期(存储时钟);每调用直查,无缓存承诺。
 */
import type { ActiveKeyRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export function resolveKeyByHash(
  ctx: UseCaseContext,
  keyHash: string,
): Promise<ActiveKeyRecord | null> {
  return ctx.store.findActiveKeyByKeyHash(ctx.db, keyHash);
}
