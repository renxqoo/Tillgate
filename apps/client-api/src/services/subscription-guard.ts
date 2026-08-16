import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { orgMembers, userSubscriptions } from '@ai-gateway/db/schema';
import { HttpError } from '@ai-gateway/http';

/**
 * 订阅归属守卫（单一实现）：用户能否把凭证（Key/App）绑定到某订阅。
 * 语义 = owner 本人，或该订阅 org 的 active 成员。
 * keys.ts / apps.ts 创建凭证时统一走这里——与账本授权侧
 * （billing-flow 的 owner/成员防御校验）互为纵深，创建面不得静默接受他人订阅。
 */
export async function assertCanUseSubscription(
  db: Db,
  userId: number,
  subscriptionId: number,
): Promise<void> {
  const sub = await db.query.userSubscriptions.findFirst({
    where: and(
      eq(userSubscriptions.id, subscriptionId),
      eq(userSubscriptions.status, 0),
      gt(userSubscriptions.endAt, new Date()),
    ),
    columns: { userId: true, orgId: true },
  });
  if (!sub) throw new HttpError('SUBSCRIPTION_NOT_FOUND', '订阅不存在或已到期');
  if (sub.userId === userId) return;
  if (sub.orgId != null) {
    const member = await db.query.orgMembers.findFirst({
      where: and(
        eq(orgMembers.orgId, sub.orgId),
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, 0),
      ),
      columns: { id: true },
    });
    if (member) return;
  }
  throw new HttpError('SUBSCRIPTION_FORBIDDEN', '无权使用该订阅');
}
