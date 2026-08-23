/**
 * 登录验证码邮件（identity Mailer port 的 SMTP/nodemailer 实现）。
 * 模板归 identity（renderLoginCodeEmail 单源）；本适配器只做传输。
 * 三要素不齐返回 null = 邮件通道 fail-closed（两级登录随之关闭，v1 语义）。
 */
import nodemailer from 'nodemailer';
import {
  renderLoginCodeEmail,
  renderPasswordResetEmail,
  type MailBrand,
  type Mailer,
} from '@tokenlens/identity';

export interface SmtpMailerConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export function createSmtpLoginMailer(
  config: SmtpMailerConfig,
  brand: MailBrand,
  emailParams: { ttlMinutes: number; maxAttempts: number },
  resetParams: { ttlMinutes: number },
  now: () => Date,
): Mailer | null {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
  return {
    async sendLoginCode(to, code, ctx) {
      const mail = renderLoginCodeEmail(code, ctx, brand, emailParams, now());
      await transport.sendMail({
        from: config.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
    async sendPasswordResetLink(to, url, ctx) {
      const mail = renderPasswordResetEmail(
        url,
        { ip: ctx.ip, ...(ctx.locale != null ? { locale: ctx.locale } : {}) },
        brand,
        { ttlMinutes: ctx.ttlMinutes },
      );
      await transport.sendMail({
        from: config.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
  };
}
