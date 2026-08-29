/**
 * OAuth 上游 fetch 带策略执行器（单次尝试超时 + 瞬态失败有限重试）：
 *   - 每次尝试经 AbortSignal.timeout 钉在 timeoutMs 内——裸 fetch 对黑洞/
 *     丢包链路要 ~75s 才报错，会把响应 socket 拖到被服务层空闲切断（反代 502）；
 *   - fetch 抛错（DNS/连接/TLS/超时中止——均未获得上游响应）或 HTTP 5xx/429
 *     时重试；4xx 是上游明确答复，原样返回不重试。
 * 重试安全性：授权码换 token 若首次已到达上游则码已消费，重试必然失败——
 * 与不重试同终态；首次未到达（连接被丢）时重试可救回登录，净收益为正。
 */
import type { OAuthUpstreamPolicy } from '../../domain/config.js';

/** 可注入 fetch(bun 类型加宽了全局 fetch——注入面收窄为可调用视图) */
type FetchLike = (...args: Parameters<typeof fetch>) => Promise<Response>;

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export interface UpstreamFetchArgs {
  readonly doFetch: FetchLike;
  readonly url: string;
  readonly init: RequestInit;
  readonly policy: OAuthUpstreamPolicy;
}

export async function oauthUpstreamFetch(args: UpstreamFetchArgs): Promise<Response> {
  const { doFetch, url, init, policy } = args;
  let lastResponse: Response | null = null;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    if (attempt > 1) {
      await new Promise((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, policy.retryDelayMs);
      });
    }
    try {
      const response = await doFetch(url, {
        ...init,
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      if (!isRetryableStatus(response.status)) return response;
      lastResponse = response;
    } catch (error) {
      // 最后一次尝试的原始错误直接上抛（调用方按网络失败口径翻译）
      if (attempt === policy.attempts) throw error;
    }
  }
  // 到达此处 = 全部尝试都拿到可重试状态响应——返回最后一个,由调用方按 !ok 报错
  if (lastResponse == null) {
    throw new Error('oauth upstream fetch exhausted without response');
  }
  return lastResponse;
}
