/**
 * 登录验证码邮件（identity Mailer port 的 SMTP/nodemailer 实现）。
 * 模板归 identity（renderLoginCodeEmail 单源）；本适配器只做传输。
 * 三要素不齐返回 null = 邮件通道 fail-closed（两级登录随之关闭）。
 */
import nodemailer from 'nodemailer';
import {
  renderLoginCodeEmail,
  renderPasswordResetEmail,
  type MailBrand,
  type Mailer,
} from '@tillgate/identity';

export interface SmtpMailerConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** 装配参数单对象(SMTP 传输配置与模板品牌/验证码/找回参数/时钟同级注入) */
export interface SmtpLoginMailerEnv {
  readonly config: SmtpMailerConfig;
  readonly brand: MailBrand;
  readonly emailParams: { ttlMinutes: number; maxAttempts: number };
  readonly resetParams: { ttlMinutes: number };
  readonly now: () => Date;
}

export function createSmtpLoginMailer(env: SmtpLoginMailerEnv): Mailer | null {
  const { config, brand, emailParams, now } = env;
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
