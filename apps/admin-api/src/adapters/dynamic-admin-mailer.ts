/**
 * 动态管理面邮件（identity Mailer 的集成设置驱动实现）。
 * 每次发送严格读快照（resolve fail-loud）；SMTP 未生效抛 undeliverable_challenge
 * （与 identity mailer 缺席路径同码）；传输器随配置指纹重建。
 * 管理面不发送找回链接——端口合规空实现（与静态版一致）。
 */
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import { identityErrors, type MailBrand, type Mailer } from '@tillgate/identity';

import { createSmtpAdminMailer, type SmtpMailerConfig } from './smtp-admin-mailer.js';

export interface DynamicAdminMailerEnv {
  readonly reader: IntegrationSettingsReader;
  readonly brand: MailBrand;
  readonly emailParams: { ttlMinutes: number; maxAttempts: number };
  readonly inviteParams: { ttlMinutes: number };
  readonly now: () => Date;
}

export function createDynamicAdminMailer(env: DynamicAdminMailerEnv): Mailer {
  const { brand, emailParams, inviteParams, now } = env;
  let fingerprint = '';
  let delegate: Mailer | null = null;

  const currentMailer = async (): Promise<Mailer | null> => {
    const snapshot = await env.reader.resolve();
    const smtp = snapshot.smtp.config;
    if (smtp == null || !snapshot.smtp.effective) return null;
    const next = `${smtp.host}|${smtp.port}|${smtp.user}|${smtp.pass}|${smtp.from}`;
    if (next !== fingerprint || delegate == null) {
      const config: SmtpMailerConfig = {
        host: smtp.host,
        port: smtp.port,
        user: smtp.user,
        pass: smtp.pass,
        from: smtp.from,
      };
      delegate = createSmtpAdminMailer({ config, brand, emailParams, inviteParams, now });
      fingerprint = next;
    }
    return delegate;
  };

  return {
    async sendLoginCode(to, code, ctx) {
      const mailer = await currentMailer();
      if (mailer == null) {
        throw identityErrors.business('undeliverable_challenge', { channel: 'email' });
      }
      return mailer.sendLoginCode(to, code, ctx);
    },
    // 用户面能力:管理面不发送找回链接——端口合规空实现(永不达)
    async sendPasswordResetLink() {
      throw new Error('admin mailer does not send reset links');
    },
    // 管理员邀请:委托当前生效传输器(SMTP 未生效统一 undeliverable_challenge)
    async sendAdminInviteLink(to, url, ctx) {
      const mailer = await currentMailer();
      if (mailer == null) {
        throw identityErrors.business('undeliverable_challenge', { channel: 'email' });
      }
      return mailer.sendAdminInviteLink(to, url, ctx);
    },
  };
}
