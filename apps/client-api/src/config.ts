/**
 * 用户面会话与业务配置（createApp 组装时注入，路由不直读环境变量）。
 */
export interface ClientApiConfig {
  /** 用户面会话 JWT 密钥（独立于管理员 ADMIN_JWT_SECRET，物理隔离） */
  jwtSecret: string;
  /** 生产环境 Cookie 加 Secure */
  secureCookie: boolean;
  /** 新用户赠送额度（元，0=关闭） */
  giftAmount: number;
  /** CSRF 受信浏览器来源（状态变更接口 Origin 校验用） */
  trustedOrigins: string[];
}
