/**
 * Hono Context Variables 类型（双身份各自独立）。
 *
 *   - ClientEnv：用户面（client-api），c.var.session 由 userSessionMiddleware 注入
 *   - AdminEnv：管理面（admin-api），c.var.adminId 由 adminSessionMiddleware 注入
 *
 * 两个 app 各自用对应的 Env 类型约束路由工厂，c.get/c.set 才有正确类型。
 * 物理隔离：ClientEnv 里没有 adminId，AdminEnv 里没有 session（用户会话）。
 */

/** 用户面会话上下文（userSessionMiddleware 注入） */
export interface UserSessionContext {
  userId: number;
}

/** 管理面会话上下文（adminSessionMiddleware 注入） */
export interface AdminSessionContext {
  adminId: number;
}

/** client-api 全局 Variables */
export type ClientEnv = {
  Variables: {
    session: UserSessionContext;
  };
};

/** admin-api 全局 Variables */
export type AdminEnv = {
  Variables: {
    /** 管理员操作人 ID（对应 admins.id）。受保护路由由 adminAuthMiddleware 保证注入，故为必填 */
    adminId: number;
  };
};
