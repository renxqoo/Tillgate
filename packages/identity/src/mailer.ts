import { createTransport, type Transporter } from 'nodemailer';

/**
 * 登录验证码发信（client-api 强制邮箱验证 / admin-api 2FA 共用）。
 *
 * SMTP 来源任意：个人邮箱（QQ/163 开 SMTP 用授权码）或企业邮箱/邮件推送服务均可，
 * 纯 env 驱动——未配置时 mailer 为 null，功能 fail-closed（登录返回 503），
 * 绝不静默降级为单密码。
 *
 * 邮件兼容性约定（QQ/163/Gmail/Outlook 通用）：
 *   - table 布局 + 全内联样式（多数客户端剔除 <style>）
 *   - 同时给 text（纯文本兜底）与 html
 */

export interface MailerConfig {
  host: string;
  port: number;
  /** 465 隐式 TLS；587/25 走 STARTTLS */
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/** 品牌口径：管理后台与用户面板各自传入，邮件头/页脚统一 */
export interface MailBrand {
  /** 邮件品牌名（中文），如「AI Gateway 管理后台」 */
  brand: string;
  /** 邮件品牌名（英文） */
  brandEn: string;
  /** 头部副标题，如「AI GATEWAY · ADMIN CONSOLE」 */
  brandSub: string;
}

export const ADMIN_MAIL_BRAND: MailBrand = {
  brand: 'AI Gateway 管理后台',
  brandEn: 'AI Gateway Admin Console',
  brandSub: 'AI GATEWAY · ADMIN CONSOLE',
};

export const USER_MAIL_BRAND: MailBrand = {
  brand: 'AI Gateway 用户面板',
  brandEn: 'AI Gateway Console',
  brandSub: 'AI GATEWAY · CLIENT CONSOLE',
};

export interface Mailer {
  /** 发送登录验证码（6 位数字，5 分钟有效）；locale 跟随触发请求（默认英文） */
  sendLoginCode(to: string, code: string, ctx: { ip: string; locale?: 'en' | 'zh' }): Promise<void>;
  /** 通用文本邮件（告警通知等 worker 场景） */
  send(to: string, subject: string, text: string): Promise<void>;
}

const STYLE = {
  pageBg: 'background:#f4f5f7;',
  card: 'background:#ffffff;border-radius:12px;overflow:hidden;max-width:420px;',
  header: 'background:#4f46e5;padding:22px 28px;',
  headerTitle: 'color:#ffffff;font-size:17px;font-weight:600;letter-spacing:1px;margin:0;',
  headerSub: 'color:#c7d2fe;font-size:11px;margin:4px 0 0;',
  body: 'padding:28px;',
  h1: 'color:#111827;font-size:16px;font-weight:600;margin:0 0 10px;',
  p: 'color:#374151;font-size:13px;line-height:1.7;margin:0 0 14px;',
  codeBox:
    'background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:18px 0;text-align:center;margin:0 0 16px;',
  code: "color:#4338ca;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;margin:0;text-indent:10px;",
  note:
    'background:#f9fafb;border-left:3px solid #4f46e5;border-radius:0 8px 8px 0;padding:10px 14px;margin:0 0 14px;',
  noteP: 'color:#4b5563;font-size:12px;line-height:1.7;margin:0;',
  warn: 'color:#b45309;font-size:12px;line-height:1.7;margin:0 0 14px;',
  footer: 'background:#f9fafb;padding:16px 28px;border-top:1px solid #eef0f3;',
  footerP: 'color:#9ca3af;font-size:11px;line-height:1.8;margin:0;',
} as const;

/** 纯渲染（可测）：验证码邮件的 subject + text + html；locale 跟随触发请求（默认英文） */
export function renderLoginCodeEmail(
  code: string,
  ctx: { ip: string; locale?: 'en' | 'zh' },
  mailBrand: MailBrand = ADMIN_MAIL_BRAND,
): { subject: string; text: string; html: string } {
  const en = ctx.locale !== 'zh';
  const { brandSub } = mailBrand;
  const brand = en ? mailBrand.brandEn : mailBrand.brand;
  const sentAt = new Date().toLocaleString(en ? 'en-US' : 'zh-CN', { hour12: false });

  const subject = en ? `[${brand}] Login verification code ${code}` : `【${brand}】登录验证码 ${code}`;

  const text = en
    ? [
        `[${brand}]`,
        '',
        'You are signing in. Your verification code is:',
        '',
        `    ${code}`,
        '',
        '- The code expires in 5 minutes; 5 failed attempts invalidate it.',
        '- If this was not you, change your password immediately.',
        '',
        `Source IP: ${ctx.ip}`,
        `Sent at: ${sentAt}`,
        '',
        'This email was sent automatically. Do not reply.',
      ].join('\n')
    : [
        `【${brand}】`,
        '',
        '你正在登录，本次登录的验证码为：',
        '',
        `    ${code}`,
        '',
        '· 验证码 5 分钟内有效，连续输错 5 次将作废；',
        '· 若非你本人操作，请立即修改密码。',
        '',
        `来源 IP：${ctx.ip}`,
        `发送时间：${sentAt}`,
        '',
        '此邮件由系统自动发送，请勿回复。',
      ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="${en ? 'en' : 'zh-CN'}">
<body style="margin:0;padding:0;${STYLE.pageBg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${STYLE.pageBg}padding:28px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" style="${STYLE.card}font-family:-apple-system,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif;">

<tr><td style="${STYLE.header}">
  <p style="${STYLE.headerTitle}">${brand}</p>
  <p style="${STYLE.headerSub}">${brandSub}</p>
</td></tr>

<tr><td style="${STYLE.body}">
  <p style="${STYLE.h1}">${en ? 'Login verification code' : '登录验证码'}</p>
  <p style="${STYLE.p}">${en ? `You are signing in to ${brand}. Use the following code to continue:` : `你正在登录${brand}，请使用以下验证码完成验证：`}</p>
  <div style="${STYLE.codeBox}"><p style="${STYLE.code}">${code}</p></div>
  <div style="${STYLE.note}">
    <p style="${STYLE.noteP}">${en ? 'The code is valid for <strong>5 minutes</strong>; <strong>5</strong> failed attempts invalidate it.' : '验证码 <strong>5 分钟内</strong>有效，连续输错 <strong>5 次</strong>将作废。'}</p>
  </div>
  <p style="${STYLE.warn}">${en ? '⚠ If this was not you, change your password immediately.' : '⚠ 若非你本人操作，请立即修改密码。'}</p>
</td></tr>

<tr><td style="${STYLE.footer}">
  <p style="${STYLE.footerP}">${en ? `Source IP: ${ctx.ip}<br/>Sent at: ${sentAt}<br/>This email was sent automatically. Do not reply.` : `来源 IP：${ctx.ip}<br/>发送时间：${sentAt}<br/>此邮件由系统自动发送，请勿回复。`}</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}

export function createMailer(config: MailerConfig, brand: MailBrand): Mailer {
  const transporter: Transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });
  return {
    async sendLoginCode(to, code, ctx) {
      const mail = renderLoginCodeEmail(code, ctx, brand);
      await transporter.sendMail({
        from: config.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
    async send(to, subject, text) {
      await transporter.sendMail({ from: config.from, to, subject, text });
    },
  };
}

/** 从 env 装配：三要素（host/user/pass）齐全才启用（from 缺省用 user），否则 null = fail-closed */
export function mailerFromEnv(
  env: {
    SMTP_HOST?: string;
    SMTP_PORT: number;
    SMTP_USER?: string;
    SMTP_PASS?: string;
    SMTP_FROM?: string;
  },
  brand: MailBrand,
): Mailer | null {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = env;
  if (!host || !user || !pass) return null;
  return createMailer(
    {
      host,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      user,
      pass,
      from: env.SMTP_FROM ?? user,
    },
    brand,
  );
}
