/**
 * 运行时快照类型（DESIGN §5 D4）：消费面（client-api/admin-api/worker）拿到的
 * 已解密、已归一形状。config 仅在 configured（必填齐全）时非 null；
 * effective = enabled && configured（OAuth provider 额外要求 oauth.base 生效）。
 */

export interface OauthBaseConfig {
  readonly frontendUrl: string;
  readonly apiBase: string;
}

export interface OauthProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export interface CaptchaConfig {
  readonly siteKey: string;
  readonly secretKey: string;
  readonly verifyUrl: string | undefined;
}

export interface EpayConfig {
  readonly pid: string;
  readonly key: string;
  readonly gatewayUrl: string;
  readonly notifyUrl: string;
  readonly returnUrl: string;
  readonly payType: string;
  /** 验签密钥序列（先新后旧；旧值仅双读窗内——DESIGN §5 D6）；下单签名恒用 key */
  readonly verifyKeys: readonly string[];
}

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly apiBase: string | undefined;
  /** webhook 验签密钥序列（先新后旧；旧值仅双读窗内） */
  readonly webhookSecrets: readonly string[];
}

/** 单集成的归一视图：三态（configured/enabled/effective）+ 已解密配置 */
export interface ResolvedIntegration<T> {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly effective: boolean;
  readonly config: T | null;
}

export interface IntegrationSnapshot {
  readonly oauth: {
    readonly base: ResolvedIntegration<OauthBaseConfig>;
    readonly github: ResolvedIntegration<OauthProviderConfig>;
    readonly google: ResolvedIntegration<OauthProviderConfig>;
  };
  readonly smtp: ResolvedIntegration<SmtpConfig>;
  readonly captcha: ResolvedIntegration<CaptchaConfig>;
  readonly payments: {
    readonly epay: ResolvedIntegration<EpayConfig>;
    readonly stripe: ResolvedIntegration<StripeConfig>;
  };
}
