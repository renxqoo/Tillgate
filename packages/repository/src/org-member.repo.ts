/** org_members 仓储：组织成员限额（订阅授权闸的成员日限 a / 子配额 b 读模型）。 */
import { and, eq } from 'drizzle-orm';
import { orgMembers } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

/** 组织成员仓储（无状态；方法统一接收 RepoContext） */
export class OrgMemberRepository {
  async memberLimits(
    c: RepoContext,
    input: { orgId: number; userId: number },
  ): Promise<{ dailySpendLimit: string | null; monthlyQuota: string | null } | null> {
    const [row] = await c.db
      .select({
        dailySpendLimit: orgMembers.dailySpendLimit,
        monthlyQuota: orgMembers.monthlyQuota,
      })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, input.orgId),
          eq(orgMembers.userId, input.userId),
          eq(orgMembers.status, 0),
        ),
      );
    return row ?? null;
  }
}
