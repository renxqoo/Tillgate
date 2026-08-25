/**
 * WebhookDeliverer 的 fetch 实现(v1 deliver() 的 webhook 分支拆出,审计通过):
 * SSRF 断言(注入 UrlGuard)→ 秒级时间戳 → HMAC 签名(domain)→ POST → res.ok。
 * 网络异常/超时收敛为 false(端口契约:布尔不抛——v1 由调用方 catch 兜底,语义等价)。
 * allowLocal 是装配层双门(env 允许且非生产)的结果值,本层不再二次判断。
 */
import type { WebhookDeliverer, WebhookDeliveryInput } from '../../ports/webhook-deliverer';
import type { UrlGuard } from '../../ports/url-guard';
import { webhookBody, signWebhook, webhookHeaders } from '../../domain/delivery';

export interface WebhookDelivererOptions {
  readonly guard: UrlGuard;
  /** POST 超时(v1=10s;须小于 claimLeaseMs) */
  readonly timeoutMs: number;
  /** dev/test 逃生门结果值(生产恒 false——装配层双门) */
  readonly allowLocal: boolean;
  readonly logger: { warn(obj: unknown, msg: string): void };
}

export function createWebhookDeliverer(options: WebhookDelivererOptions): WebhookDeliverer {
  return {
    async deliver(input: WebhookDeliveryInput): Promise<boolean> {
      if (!input.url) return false;
      try {
        await options.guard.assert(input.url, { allowLocal: options.allowLocal });
      } catch (error) {
        options.logger.warn(
          { url: input.url, error: (error as Error).message },
          'webhook url blocked by ssrf guard',
        );
        return false;
      }
      const timestamp = Math.floor(Date.now() / 1000);
      const body = webhookBody(input.event, timestamp, input.payload);
      const signature = signWebhook(input.secret, timestamp, body);
      let res: Response;
      try {
        res = await fetch(input.url, {
          method: 'POST',
          // 守卫只校验初始 URL；3x 不自动跟随（过审 https 地址可 30x 跳内网/
          // metadata，307/308 还保留 POST 体）——3x 视为投递失败，下轮重试
          redirect: 'manual',
          headers: {
            ...webhookHeaders({
              deliveryId: input.deliveryId,
              event: input.event,
              timestamp,
              signature,
            }),
          },
          body,
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch {
        return false; // 网络异常/超时:本轮失败可重试
      }
      if (!res.ok) {
        options.logger.warn({ status: res.status, event: input.event }, 'webhook deliver failed');
      }
      return res.ok;
    },
  };
}
