/**
 * OAuth 上游协议 port(Authorization Code 流半程)。内置实现见 adapters/oauth/
 * {github,google}.ts(端点可覆盖);自定义 provider 由装配注入同接口实现。
 * profile 失败抛错由 application 统一翻译为 oauth_profile_failed。
 */
export interface OAuthProvider {
  /** 授权跳转 URL(state 已含;scope/redirect_uri 由适配器按平台拼装) */
  authorizeUrl(input: { redirectUri: string; state: string }): string;
  /** code → access_token → profile(上游邮箱仅取已验证主邮箱) */
  exchangeAndProfile(input: { code: string; redirectUri: string }): Promise<OAuthProfile>;
}

export interface OAuthProfile {
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string | null;
}
