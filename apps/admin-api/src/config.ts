/**
 * 管理面会话配置（createApp 组装时注入，路由不直读环境变量）。
 */
export interface AdminApiConfig {
  /** 管理员会话 JWT 密钥（独立于用户面 JWT_SECRET，物理隔离） */
  adminJwtSecret: string;
  /** 生产环境 Cookie 加 Secure */
  secureCookie: boolean;
  /** CSRF 受信浏览器来源（状态变更接口 Origin 校验用） */
  trustedOrigins: string[];
  /** 渠道进货凭证截图本地存储目录 */
  voucherStorageDir: string;
  /** 凭证截图最大字节数 */
  voucherMaxBytes: number;
}
