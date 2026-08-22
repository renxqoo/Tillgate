/**
 * 单渠道投递分派(v1 deliver() 的类型分支拆出,审计通过):
 * webhook = 解密(fail-closed 链)→ WebhookDeliverer;email = 模板渲染 → EmailSender;
 * 未知类型兜底 false。解密在 application,传输在 port(IMPLEMENTATION §2 裁决)。
 */
import type { SecretCipher } from '../ports/secret-cipher';
import type { EmailSender } from '../ports/email-sender';
import type { WebhookDeliverer } from '../ports/webhook-deliverer';
import { renderAlertEmail } from '../templates/alert-email';

export interface DeliverToChannelDeps {
  readonly cipher: SecretCipher;
  /** 缺省 undefined = email 渠道 fail-closed(v1 mailer 未配置语义) */
  readonly emailSender?: EmailSender;
  readonly webhookDeliverer: WebhookDeliverer;
  readonly emailBrand: string;
}

export interface DeliverToChannelInput {
  /** 投递标识 `${outboxId}:${channelId}`(接收方幂等锚) */
  readonly deliveryId: string;
  readonly channelType: string;
  readonly config: Record<string, unknown>;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

export async function deliverToChannel(
  deps: DeliverToChannelDeps,
  input: DeliverToChannelInput,
): Promise<boolean> {
  if (input.channelType === 'webhook') {
    const url = typeof input.config.url === 'string' ? input.config.url : '';
    const secret = typeof input.config.secret === 'string' ? input.config.secret : '';
    if (!url) return false;
    // secret 只允许统一密文形态:缺密钥、明文存量或解密失败都 fail-closed(v1 语义)
    if (!secret.startsWith('enc:')) return false;
    let plaintext: string;
    try {
      plaintext = deps.cipher.decrypt(secret);
    } catch {
      return false;
    }
    return deps.webhookDeliverer.deliver({
      url,
      secret: plaintext,
      event: input.event,
      payload: input.payload,
      deliveryId: input.deliveryId,
    });
  }
  if (input.channelType === 'email') {
    const recipients = Array.isArray(input.config.recipients)
      ? (input.config.recipients as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];
    const sender = deps.emailSender;
    if (recipients.length === 0 || !sender) return false; // SMTP 未配置 fail-closed
    const mail = renderAlertEmail(input.event, input.payload, deps.emailBrand);
    await Promise.all(recipients.map((to) => sender.send(to, mail.subject, mail.text)));
    return true;
  }
  return false;
}
