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
    /** 管理员操作人 ID（对应 admins.id）；机器令牌调用时可能为 undefined */
    adminId?: number;
  };
};

/**
 * 兼容旧代码的 AdminEnv 别名。
 * 旧 admin-api 路由工厂签名大量使用 Hono<AdminEnv> 且读 c.get('adminId')，
 * 拆分后管理面路由仍用此类型（adminId 由 adminIdInjector 注入）。
 * 用户面路由迁到 client-api 后改用 ClientEnv。
 */
export type LegacyAdminEnv = AdminEnv;
