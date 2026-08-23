/**
 * 验证码邮件渲染纯函数(中英双语,locale 跟随触发请求,默认英文)。
 * 兼容性约定(QQ/163/Gmail/Outlook 通用):table 布局 + 全内联样式(多数客户端剔除
 * <style>),同时给 text(纯文本兜底)与 html。品牌口径:管理面与用户面各自注入。
 */

export interface MailBrand {
  /** 邮件品牌名(中文),如「TokenLens 管理后台」 */
  readonly brand: string;
  /** 邮件品牌名(英文) */
  readonly brandEn: string;
  /** 头部副标题,如「TOKENLENS · ADMIN CONSOLE」 */
  readonly brandSub: string;
}

export interface LoginCodeEmailContext {
  /** 验证码有效期(分钟,随挑战 ttl 装配传入) */
  readonly ttlMinutes: number;
  /** 邮件内提示的错次上限(随挑战 maxAttempts) */
  readonly maxAttempts: number;
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
  note: 'background:#f9fafb;border-left:3px solid #4f46e5;border-radius:0 8px 8px 0;padding:10px 14px;margin:0 0 14px;',
  noteP: 'color:#4b5563;font-size:12px;line-height:1.7;margin:0;',
  warn: 'color:#b45309;font-size:12px;line-height:1.7;margin:0 0 14px;',
  footer: 'background:#f9fafb;padding:16px 28px;border-top:1px solid #eef0f3;',
  footerP: 'color:#9ca3af;font-size:11px;line-height:1.8;margin:0;',
} as const;

/** 渲染验证码邮件(subject + text + html);时间格式化由 now 注入(可测) */
export function renderLoginCodeEmail(
  code: string,
  ctx: { ip: string; locale?: 'en' | 'zh' },
  mailBrand: MailBrand,
  params: LoginCodeEmailContext,
  now: Date,
): { subject: string; text: string; html: string } {
  const en = ctx.locale !== 'zh';
  const { brandSub, ttlMinutes, maxAttempts } = { ...mailBrand, ...params };
  const brand = en ? mailBrand.brandEn : mailBrand.brand;
  const sentAt = now.toLocaleString(en ? 'en-US' : 'zh-CN', { hour12: false });

  const subject = en
    ? `[${brand}] Login verification code ${code}`
    : `【${brand}】登录验证码 ${code}`;

  const text = en
    ? [
        `[${brand}]`,
        '',
        'You are signing in. Your verification code is:',
        '',
        `    ${code}`,
        '',
        `- The code expires in ${ttlMinutes} minutes; ${maxAttempts} failed attempts invalidate it.`,
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
        '你正在登录,本次登录的验证码为:',
        '',
        `    ${code}`,
        '',
        `· 验证码 ${ttlMinutes} 分钟内有效,连续输错 ${maxAttempts} 次将作废;`,
        '· 若非你本人操作,请立即修改密码。',
        '',
        `来源 IP:${ctx.ip}`,
        `发送时间:${sentAt}`,
        '',
        '此邮件由系统自动发送,请勿回复。',
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
  <p style="${STYLE.p}">${en ? `You are signing in to ${brand}. Use the following code to continue:` : `你正在登录${brand},请使用以下验证码完成验证:`}</p>
  <div style="${STYLE.codeBox}"><p style="${STYLE.code}">${code}</p></div>
  <div style="${STYLE.note}">
    <p style="${STYLE.noteP}">${en ? `The code is valid for <strong>${ttlMinutes} minutes</strong>; <strong>${maxAttempts}</strong> failed attempts invalidate it.` : `验证码 <strong>${ttlMinutes} 分钟内</strong>有效,连续输错 <strong>${maxAttempts} 次</strong>将作废。`}</p>
  </div>
  <p style="${STYLE.warn}">${en ? '⚠ If this was not you, change your password immediately.' : '⚠ 若非你本人操作,请立即修改密码。'}</p>
</td></tr>

<tr><td style="${STYLE.footer}">
  <p style="${STYLE.footerP}">${en ? `Source IP: ${ctx.ip}<br/>Sent at: ${sentAt}<br/>This email was sent automatically. Do not reply.` : `来源 IP:${ctx.ip}<br/>发送时间:${sentAt}<br/>此邮件由系统自动发送,请勿回复。`}</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}
