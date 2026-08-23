/** 登录成功时间戳推进（SQL now()——多副本时钟纪律,app best-effort 消费） */
import type { AdminsDeps } from './admins-shared';

export function touchLastLogin(deps: AdminsDeps, adminId: number): Promise<void> {
  return deps.store.touchLastLogin(deps.db, adminId);
}
