/**
 * 动态登录邮件（identity Mailer 的集成设置驱动实现）。
 * 每次发送严格读快照（resolve fail-loud——发送面不允许陈旧凭据）；SMTP 失效抛
 * undeliverable_challenge（与 identity mailer 缺席路径同码，fail-closed 语义不漂移）；
 * 传输器随配置指纹重建（nodemailer transport 与 SmtpConfig 一一对应）。
 */
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import { identityErrors, type MailBrand, type Mailer } from '@tillgate/identity';

import { createSmtpLoginMailer, type SmtpMailerConfig } from './smtp-login-mailer.js';

export interface DynamicLoginMailerEnv {
  readonly reader: IntegrationSettingsReader;
  readonly brand: MailBrand;
  readonly emailParams: { ttlMinutes: number; maxAttempts: number };
  readonly resetParams: { ttlMinutes: number };
  readonly now: () => Date;
}

/** SMTP 未生效的统一抛错（与 identity mailer 缺席分支同码——wire 语义不漂移） */
function unavailable(): never {
  throw identityErrors.business('undeliverable_challenge', { channel: 'email' });
}

export function createDynamicLoginMailer(env: DynamicLoginMailerEnv): Mailer {
  const { brand, emailParams, resetParams, now } = env;
  let fingerprint = '';
  let delegate: Mailer | null = null;

  /** 当前生效传输（effective 才可用；配置指纹变化即重建传输器） */
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
      delegate = createSmtpLoginMailer({ config, brand, emailParams, resetParams, now });
      fingerprint = next;
    }
    return delegate;
  };

  return {
    async sendLoginCode(to, code, ctx) {
      const mailer = await currentMailer();
      if (mailer == null) return unavailable();
      return mailer.sendLoginCode(to, code, ctx);
    },
    async sendPasswordResetLink(to, url, ctx) {
      const mailer = await currentMailer();
      if (mailer == null) return unavailable();
      return mailer.sendPasswordResetLink(to, url, ctx);
    },
  };
}
