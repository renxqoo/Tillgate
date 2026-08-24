/**
 * 管理员登录验证码邮件（identity Mailer port 的 SMTP/nodemailer 实现,
 * client-api smtp-login-mailer 同款——模板归 identity renderLoginCodeEmail 单源,
 * 本适配器只做传输）。由 config.smtp 构造:null = 邮件通道 fail-closed
 * （2FA 随之不可开启/不可用,v1 语义）。装配面文件:仅 assembly 引用。
 */
import nodemailer from 'nodemailer';
import { renderLoginCodeEmail, type MailBrand, type Mailer } from '@tillgate/identity';

export interface SmtpMailerConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

/** 装配参数单对象(模板品牌/验证码参数/时钟与 SMTP 传输配置同级注入) */
export interface SmtpAdminMailerEnv {
  readonly config: SmtpMailerConfig;
  readonly brand: MailBrand;
  readonly emailParams: { ttlMinutes: number; maxAttempts: number };
  readonly now: () => Date;
}

export function createSmtpAdminMailer(env: SmtpAdminMailerEnv): Mailer {
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
    // 用户面能力:管理面不发送找回链接——端口合规空实现(永不达)
    async sendPasswordResetLink() {
      throw new Error('admin mailer does not send reset links');
    },
  };
}
