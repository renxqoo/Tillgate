/**
 * OAuth 授权跳转半程:state 签发(单次存储,不可达 fail-closed 拒绝——带不上单次
 * state 的跳转必坏,v1 语义)+ provider 授权 URL。cookie 双提交比对与 next 归一
 * 归 app HTTP 层(D7)。
 */
import { randomBytes } from 'node:crypto';
import { identityErrors } from '../domain/errors.js';
import { guardProvider } from '../domain/identifier.js';
import { assertRedirectAllowed } from '../domain/config.js';
import type { IdentityUseCaseContext } from './context.js';

export interface OAuthAuthorizeInput {
  readonly provider: string;
  readonly redirectUri: string;
  /** 回跳上下文(原样随 state 往返;归一归 app) */
  readonly next?: string;
}

export async function oauthAuthorize(
  ctx: IdentityUseCaseContext,
  input: OAuthAuthorizeInput,
): Promise<{ url: string; state: string }> {
  const provider = guardProvider(input.provider, ctx.guards);
  const providerAdapter = ctx.oauthProviders[provider];
  if (providerAdapter == null) {
    throw identityErrors.business('oauth_provider_unconfigured', { provider });
  }
  if (ctx.oauthStateStore == null) {
    throw identityErrors.business('oauth_state_unavailable', { provider });
  }
  // 回调地址精确匹配白名单(fail-closed,防授权码截断/开放重定向)
  const redirectUri = assertRedirectAllowed(ctx.config, input.redirectUri);
  const state = randomBytes(24).toString('hex');
  try {
    await ctx.oauthStateStore.save(
      state,
      { provider, ...(input.next != null ? { next: input.next } : {}) },
      ctx.config.oauthStateTtlSec,
    );
  } catch (error) {
    ctx.logger.warn({ err: (error as Error).message, provider }, 'oauth state save failed');
    throw identityErrors.business('oauth_state_unavailable', { provider });
  }
  return { url: providerAdapter.authorizeUrl({ redirectUri, state }), state };
}
