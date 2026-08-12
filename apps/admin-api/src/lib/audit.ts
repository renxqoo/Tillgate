/**
 * 审计写入已抽到 @ai-gateway/billing。
 * 本文件重新导出，保持现有 import 可用。新代码请直接 import @ai-gateway/billing。
 *
 * 拆分后：adminId 引用 admins.id（管理员手动操作）；系统任务 adminId 传 null + actor='system'。
 */
export { recordAudit } from '@ai-gateway/billing';
