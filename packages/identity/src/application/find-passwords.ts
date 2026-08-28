/**
 * 批量读「已设密码」的 userId 子集(邀请激活态投影——管理端列表单查防 N+1)。
 * 纯读无事务临界区(mfa.status 同款直查);逐 id 校验防垃圾形状进 SQL。
 */
import type { IdentityUseCaseContext } from './context.js';
import { assertUserId } from '../domain/identifier.js';

export async function findPasswordUserIds(
  ctx: IdentityUseCaseContext,
  input: { userIds: readonly number[] },
): Promise<number[]> {
  return ctx.credentialStore.findPasswordUserIds(ctx.db, input.userIds.map(assertUserId));
}
