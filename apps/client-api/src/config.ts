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
  /** 可信反向代理层数（XFF 信任模型；0=不信任 XFF） */
  trustedProxyHops: number;
  /** BFF 服务间令牌（CSRF fail-closed；未配置=兼容期放行双缺失头） */
  internalApiToken?: string;
  /** 邮箱自助注册开关（默认开；关闭只留 OAuth 建号，存量账号登录不受影响） */
  registerEnabled: boolean;
  /** 邀请返利参数 */
  referralSignupBonus: number;
  referralCommissionRate: number;
  /** Playground 网关桥（GATEWAY_URL + GATEWAY_JWT_SECRET 成组配置才启用） */
  playground: { gatewayUrl: string; gatewayJwtSecret: string } | null;
  /** 在线支付渠道（未配置的渠道关闭；null = 支付整体关闭） */
  payments: {
    epay: { pid: string; key: string; gatewayUrl: string; notifyUrl: string; returnUrl: string } | null;
    stripe: { secretKey: string; webhookSecret: string; webhookUrl: string; successUrl: string; cancelUrl: string } | null;
  };
  /** OAuth 社交登录（未配置的 provider 端点 404、前端按钮隐藏） */
  oauth: {
    /** 登录完成后重定向回的前端地址 */
    frontendUrl: string;
    /** 本服务对外可达基地址（拼 redirect_uri） */
    apiBase: string;
    github: OAuthCredentials | null;
    google: OAuthCredentials | null;
    /** 端点覆盖（默认公网 GitHub/Google；测试或私有化网关用） */
    endpoints?: {
      github?: { authorizeUrl: string; tokenUrl: string; profileUrl: string; emailsUrl: string };
      google?: { authorizeUrl: string; tokenUrl: string; profileUrl: string };
    };
  };
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}
