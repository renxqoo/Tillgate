/**
 * 账号状态词汇（users 与 admins 同语义，单一真相）。
 *
 * 表列 CHECK 约束（users_status_ck / admins_status_chk）与此处常量集合一致：
 * 新增状态必须同时改约束迁移与本常量——库层挡非法值，编译层挡魔法数字。
 * 判定走常量/谓词，不裸写数字；账号 status 不经实体行为修改（SQL 直改），
 * 故词汇以数据形态提供，值跨 Redis/队列序列化后依然可用。
 */
export const ACCOUNT_STATUS = { ACTIVE: 0, BANNED: 1, DELETED: 2 } as const;

export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

/** 账号可登录使用（未封禁未注销）——登录/验码/会话中间件共用的单一判定 */
export function isAccountUsable(status: number): boolean {
  return status === ACCOUNT_STATUS.ACTIVE;
}
