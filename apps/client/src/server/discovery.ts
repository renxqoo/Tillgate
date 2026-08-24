/**
 * 登录/注册页公开探测（未登录可达）：OAuth 按钮发现 + 注册能力（开关/验证码
 * siteKey/邮箱验证码开关）。探测失败按「全开」语义回落（v1 刻意取舍 B20：
 * 探测失败不隐藏入口，由提交动作的 403/错误码兜底）。
 */
import type { AuthCapabilities, OAuthProviders } from '@tillgate/api-client';

import { createClientApi } from './api';

/** fetch 包装：限定超时（探测是渲染增强，不允许拖慢页面 SSR） */
function timeoutFetch(ms: number): typeof globalThis.fetch {
  return (async (input, init) =>
    globalThis.fetch(input, {
      ...init,
      signal: AbortSignal.timeout(ms),
    })) as typeof globalThis.fetch;
}

const PROBE_TIMEOUT_MS = 1500;

/** OAuth 登录方式发现（空数组=纯密码登录；不可达按空处理——按钮组隐藏） */
export async function fetchOAuthProviders(): Promise<string[]> {
  try {
    const res = await createClientApi({
      fetch: timeoutFetch(PROBE_TIMEOUT_MS),
    }).get<OAuthProviders>('/v1/oauth/providers', { revalidate: false });
    return res.providers;
  } catch {
    return [];
  }
}

/** 注册/登录能力探测；不可达按全开回落（B20 取舍语义） */
export async function fetchAuthCapabilities(): Promise<AuthCapabilities> {
  try {
    return await createClientApi({ fetch: timeoutFetch(PROBE_TIMEOUT_MS) }).get<AuthCapabilities>(
      '/v1/auth/capabilities',
      { revalidate: false },
    );
  } catch {
    return { registerEnabled: true, captchaSiteKey: null, emailCodeRequired: false };
  }
}
