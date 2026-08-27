/** App JWT 校验读模型:appId 等值 + 双 status 守卫 */
import type { ActiveAppRecord } from '../ports/account-store.js';
import type { UseCaseContext } from './context.js';

export function resolveApp(ctx: UseCaseContext, appId: string): Promise<ActiveAppRecord | null> {
  return ctx.store.findActiveAppByAppId(ctx.db, appId);
}
