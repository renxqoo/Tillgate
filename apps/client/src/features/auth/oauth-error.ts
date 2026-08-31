/**
 * OAuth 回调错误码 → 结构化文案映射（纯函数）：client-api 回调失败时以
 * `?oauth_error=<code>` 302 回传服务端错误码，本映射只命中固定白名单，
 * 未命中一律回落通用文案——错误码本身永不直接渲染（不可信输入不进 DOM）。
 */

/** 错误类别：一个类别对应一组固定标题/描述文案与一套卡片图标/色调 */
export type OAuthErrorKind = 'service' | 'state' | 'account' | 'registerClosed' | 'generic';

/**
 * 结构化文案 key：只产出字面量联合类型（不外泄 string），保证
 * `t(titleKey)` / `t(descKey)` 的动态 key 在 typecheck 期可证明存在于
 * messages（zh/en 两语言同 key 面）。
 */
export interface OAuthErrorCopy {
  kind: OAuthErrorKind;
  titleKey: OAuthErrorTitleKey;
  descKey: OAuthErrorDescKey;
}

export type OAuthErrorTitleKey =
  | 'oauthErrorServiceTitle'
  | 'oauthErrorStateTitle'
  | 'oauthErrorAccountTitle'
  | 'oauthErrorRegisterClosedTitle'
  | 'oauthErrorGenericTitle';

export type OAuthErrorDescKey =
  | 'oauthErrorServiceDesc'
  | 'oauthErrorStateDesc'
  | 'oauthErrorAccountDesc'
  | 'oauthErrorRegisterClosedDesc'
  | 'oauthErrorGenericDesc';

export function oauthErrorCopy(code: string): OAuthErrorCopy {
  switch (code) {
    // 上游换码/拉资料失败（境内直连 GitHub/Google 间歇不可用的主路径）→ 引导邮箱登录
    case 'identity.oauth_profile_failed':
      return {
        kind: 'service',
        titleKey: 'oauthErrorServiceTitle',
        descKey: 'oauthErrorServiceDesc',
      };
    case 'client.oauth_state_mismatch':
    case 'identity.oauth_state_invalid':
    case 'identity.oauth_state_unavailable':
      return {
        kind: 'state',
        titleKey: 'oauthErrorStateTitle',
        descKey: 'oauthErrorStateDesc',
      };
    case 'client.account_unavailable':
      return {
        kind: 'account',
        titleKey: 'oauthErrorAccountTitle',
        descKey: 'oauthErrorAccountDesc',
      };
    case 'client.register_disabled':
      return {
        kind: 'registerClosed',
        titleKey: 'oauthErrorRegisterClosedTitle',
        descKey: 'oauthErrorRegisterClosedDesc',
      };
    default:
      return {
        kind: 'generic',
        titleKey: 'oauthErrorGenericTitle',
        descKey: 'oauthErrorGenericDesc',
      };
  }
}
