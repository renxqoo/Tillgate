import { auditLogs } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';

/**
 * 管理操作审计写入（data-model.md §3.14 / requirements 4.10）。
 *
 *   - actor：admin（管理员，adminId 引用 admins.id）/ system（对账/赠送/自动冻结等系统任务，adminId 为 NULL）
 *   - action：如 channel.update / user.adjust / rate_card.create / user.signup_gift
 *   - detail：变更前后摘要（jsonb），用于合规/安全审计回溯
 *
 * 失败容错：审计写入失败不应阻塞业务主流程（已落库的操作不可回滚），
 *          仅记日志；审计本就是「尽力而为」的旁路记录。
 *
 * 纯写入函数：注入 Db，无其它依赖，路由层 fire-and-forget 调用。
 *
 * 拆分后：adminId 引用 admins.id（管理员手动操作）；系统任务 adminId 传 null + actor='system'。
 *       用户自助行为（改密码/兑换）若需审计，adminId 传 null（这些不是管理员动作）。
 */
export async function recordAudit(
  db: Db,
  input: {
    /** 管理员操作人 ID（admins.id）；系统/用户触发动作传 null */
    adminId?: number | null;
    actor?: 'admin' | 'system';
    action: string;
    targetType: string;
    targetId?: string | number | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      adminId: input.adminId ?? null,
      actor: input.actor ?? 'admin',
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId != null ? String(input.targetId) : null,
      detail: input.detail ?? null,
    });
  } catch (err) {
    // 审计写失败不阻塞主流程（业务已落库）；记录到日志便于排查
    console.error('[audit] write failed', { action: input.action, err: (err as Error).message });
  }
}
