/**
 * OAuth 回调半程:state 单次消费(GETDEL;不存在/已过期/provider 不匹配拒绝)
 * → code 换 profile(上游失败 → oauth_profile_failed,含 GitHub 邮箱端点降级
 * email=null 的 B27 口径)。find-or-create 编排与建号赠送归 app(G4)。
 */
import { identityErrors } from '../domain/errors.js';
import { guardProvider } from '../domain/identifier.js';
import { assertRedirectAllowed } from '../domain/config.js';
import type { OAuthProfile } from '../ports/oauth-provider.js';
import type { OAuthStatePayload } from '../ports/oauth-state-store.js';
import type { IdentityUseCaseContext } from './context.js';

export interface OAuthCallbackInput {
  readonly provider: string;
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}

export interface OAuthCallbackResult extends OAuthProfile {
  readonly provider: string;
  readonly next: string | undefined;
}

export async function oauthCallback(
  ctx: IdentityUseCaseContext,
  input: OAuthCallbackInput,
): Promise<OAuthCallbackResult> {
  const provider = guardProvider(input.provider, ctx.guards);
  const providerAdapter = ctx.oauthProviders[provider];
  if (providerAdapter == null) {
    throw identityErrors.business('oauth_provider_unconfigured', { provider });
  }
  if (ctx.oauthStateStore == null) {
    throw identityErrors.business('oauth_state_unavailable', { provider });
  }

  let stored: OAuthStatePayload | null;
  try {
    stored = await ctx.oauthStateStore.consume(input.state);
  } catch (error) {
    // 不可达按已过期拒绝(fail-closed,v1 语义)
    ctx.logger.warn({ err: (error as Error).message, provider }, 'oauth state consume failed');
    throw identityErrors.business('oauth_state_unavailable', { provider });
  }
  if (stored == null || stored.provider !== provider) {
    throw identityErrors.business('oauth_state_invalid', { provider });
  }
  if (typeof input.code !== 'string' || input.code.length === 0) {
    throw identityErrors.business('invalid_input', {
      field: 'code',
      reason: 'missing authorization code',
    });
  }
  // 回调地址与 authorize 半程同一白名单精确匹配(防止换 URI 换码)
  const redirectUri = assertRedirectAllowed(ctx.config, input.redirectUri);

  let profile: OAuthProfile;
  try {
    profile = await providerAdapter.exchangeAndProfile({
      code: input.code,
      redirectUri,
    });
  } catch (error) {
    ctx.logger.warn({ err: (error as Error).message, provider }, 'oauth upstream exchange failed');
    throw identityErrors.business('oauth_profile_failed', {
      provider,
      detail: (error as Error).message,
    });
  }
  return {
    provider,
    subject: profile.subject,
    email: profile.email,
    displayName: profile.displayName,
    next: stored.next,
  };
}
