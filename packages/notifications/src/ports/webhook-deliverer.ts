/**
 * webhook 投递 port:SSRF 断言 + HMAC 签名 + POST 的整体外部副作用。
 * secret 为已解密明文(解密在 application 经 SecretCipher);返回 false = 本轮投递失败
 * (可重试),不抛——异常语义由实现内部收敛为布尔。
 */
export interface WebhookDeliveryInput {
  readonly url: string;
  readonly secret: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  /** 投递标识 `${outboxId}:${channelId}`(接收方幂等锚) */
  readonly deliveryId: string;
}

export interface WebhookDeliverer {
  deliver(input: WebhookDeliveryInput): Promise<boolean>;
}
