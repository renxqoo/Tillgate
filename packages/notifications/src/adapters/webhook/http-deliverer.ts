/**
 * WebhookDeliverer 实现:
 * SSRF 断言(注入 UrlGuard)→ 秒级时间戳 → HMAC 签名(domain)→ 守卫拨号传输 POST。
 * 传输缺省 = createGuardedNodeTransport（拨号层逐地址断言——DNS rebinding 的
 * 校验/拨号两次解析窗口结构性消除）;测试可注入替身传输。
 * 网络异常/超时收敛为 false(端口契约:布尔不抛)。
 * allowLocal 是装配层双门(env 允许且非生产)的结果值,本层不再二次判断。
 */
import type { WebhookDeliverer, WebhookDeliveryInput } from '../../ports/webhook-deliverer';
import type { UrlGuard } from '../../ports/url-guard';
import { webhookBody, signWebhook, webhookHeaders } from '../../domain/delivery';
import { createGuardedNodeTransport, type GuardedHttpPost } from './node-transport';

export interface WebhookDelivererOptions {
  readonly guard: UrlGuard;
  /** POST 超时;须小于 claimLeaseMs */
  readonly timeoutMs: number;
  /** dev/test 逃生门结果值(生产恒 false——装配层双门) */
  readonly allowLocal: boolean;
  readonly logger: { warn(obj: unknown, msg: string): void };
  /** 传输注入点(缺省守卫拨号传输;测试替身用) */
  readonly transport?: GuardedHttpPost;
}

export function createWebhookDeliverer(options: WebhookDelivererOptions): WebhookDeliverer {
  const transport =
    options.transport ?? createGuardedNodeTransport(options.guard, options.allowLocal);
  return {
    async deliver(input: WebhookDeliveryInput): Promise<boolean> {
      if (!input.url) return false;
      let target: URL;
      try {
        target = await options.guard.assert(input.url, { allowLocal: options.allowLocal });
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
      const res = await transport({
        url: target,
        // 展开为普通对象字面量（interface 形态无隐式索引签名,传输入参按记录形收）
        headers: {
          ...webhookHeaders({
            deliveryId: input.deliveryId,
            event: input.event,
            timestamp,
            signature,
          }),
        },
        body,
        timeoutMs: options.timeoutMs,
      });
      if (!res.ok) {
        options.logger.warn({ status: res.status, event: input.event }, 'webhook deliver failed');
      }
      return res.ok;
    },
  };
}
