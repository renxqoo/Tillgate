/**
 * 管理面会话配置（createApp 组装时注入，路由不直读环境变量）。
 */
export interface AdminApiConfig {
  /** 管理员会话 JWT 密钥（独立于用户面 JWT_SECRET，物理隔离） */
  adminJwtSecret: string;
  /** 生产环境 Cookie 加 Secure */
  secureCookie: boolean;
}
