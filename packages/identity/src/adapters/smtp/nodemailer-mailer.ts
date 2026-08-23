/**
 * 验证码邮件 SMTP 实现(nodemailer)。渲染见 templates/login-code-email.ts(纯函数,
 * 双语 + 内联样式——多数邮件客户端剔除 <style>,table 布局 + 全内联是 QQ/163/Gmail/
 * Outlook 通用兼容口径)。env 解析(mailerFromEnv)归 app 装配,本适配器只收显式参数。
 */
import { createTransport, type Transporter } from 'nodemailer';
import {
  renderLoginCodeEmail,
  type LoginCodeEmailContext,
  type MailBrand,
} from '../../templates/login-code-email.js';
import { renderPasswordResetEmail } from '../../templates/password-reset-email.js';
import type { Mailer } from '../../ports/mailer.js';
import type { Clock } from '../../ports/clock.js';

export interface SmtpMailerConfig {
  readonly host: string;
  readonly port: number;
  /** 465 隐式 TLS;587/25 走 STARTTLS */
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export function createNodemailerMailer(
  config: SmtpMailerConfig,
  brand: MailBrand,
  emailParams: LoginCodeEmailContext,
  clock: Clock,
): Mailer {
  const transporter: Transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  return {
    async sendLoginCode(to, code, ctx) {
      const mail = renderLoginCodeEmail(code, ctx, brand, emailParams, clock.now());
      await transporter.sendMail({
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
      await transporter.sendMail({
        from: config.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
  };
}
