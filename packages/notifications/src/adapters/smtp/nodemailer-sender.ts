/**
 * EmailSender 的 SMTP 实现(nodemailer;v1 identity/mailer 的通用 send 面,审计通过):
 * 仅承运维告警文本邮件——验证码渲染面归 identity 包(DESIGN §1)。
 * 装配三要素(host/user/pass)齐全才启用,否则 null = email 渠道 fail-closed(v1 mailerFromEnv)。
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailSender } from '../../ports/email-sender';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** 465 隐式 TLS;587/25 走 STARTTLS */
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

export function createSmtpEmailSender(config: SmtpConfig): EmailSender {
  const transporter: Transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  return {
    async send(to, subject, text) {
      await transporter.sendMail({ from: config.from, to, subject, text });
    },
  };
}

/** 从 env 装配:三要素齐全启用(from 缺省用 user),否则 null = fail-closed */
export function smtpSenderFromEnv(env: {
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
}): EmailSender | null {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = env;
  if (!host || !user || !pass) return null;
  return createSmtpEmailSender({
    host,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    user,
    pass,
    from: env.SMTP_FROM ?? user,
  });
}
