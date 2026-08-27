/**
 * 管理员邀请邮件渲染纯函数(中英双语,locale 跟随创建/重发操作者,默认英文)。
 * 布局兼容性口径与 password-reset-email 相同(table + 全内联样式 + text 兜底);
 * 正文承载一次性「设置初始密码」链接(按钮形态),绝不附带验证码/密码等其它凭据。
 * 与找回密码的差异:收件人尚无密码(新建管理员邀请),文案按「设置密码」措辞。
 */
import { MAIL_BASE_STYLE, MAIL_FONT_FAMILY, type MailBrand } from './login-code-email.js';

export interface AdminInviteEmailContext {
  /** 链接有效期(分钟) */
  readonly ttlMinutes: number;
}

/** 邀请邮件专有样式(与 password-reset-email 同口径:黑色按钮形态链接) */
const STYLE = {
  btn: 'display:inline-block;background:#000000;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:12px 32px;border-radius:10px;margin:8px 0 16px;',
  link: 'color:#333333;font-size:13px;word-break:break-all;margin:0 0 16px;line-height:1.7;',
} as const;

/** 渲染管理员邀请邮件(subject + text + html) */
// eslint-disable-next-line max-params -- 渲染入参四要素各有其位(与 renderPasswordResetEmail 同款:公共导出,调用方按位置参数锁定)
export function renderAdminInviteEmail(
  url: string,
  ctx: { locale?: 'en' | 'zh' },
  mailBrand: MailBrand,
  params: AdminInviteEmailContext,
): { subject: string; text: string; html: string } {
  const en = ctx.locale !== 'zh';
  const brand = en ? mailBrand.brandEn : mailBrand.brand;
  const subject = en
    ? `[${mailBrand.brandEn}] Set your admin password (${params.ttlMinutes} min)`
    : `【${mailBrand.brand}】设置管理后台密码(${params.ttlMinutes} 分钟内有效)`;
  const text = en
    ? `You have been invited to ${mailBrand.brandEn}\n\nOpen the link below to set your admin password (valid for ${params.ttlMinutes} minutes, one-time use):\n${url}\n\nIf you were not expecting this invitation, ignore this email — no account action is taken.\n${mailBrand.brandEn}`
    : `你被邀请加入${mailBrand.brand}\n\n点击下面的链接设置登录密码(${params.ttlMinutes} 分钟内有效,仅可使用一次):\n${url}\n\n如果这不是你本人的操作,请忽略本邮件——不会产生任何变更。\n${mailBrand.brand}`;
  const html = `<!DOCTYPE html>
<html lang="${en ? 'en' : 'zh-CN'}">
<body style="margin:0;padding:0;${MAIL_BASE_STYLE.pageBg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${MAIL_BASE_STYLE.pageBg}">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="${MAIL_BASE_STYLE.card}${MAIL_FONT_FAMILY}">
<tr><td align="left" style="${MAIL_BASE_STYLE.body}">

<p style="${MAIL_BASE_STYLE.logo}">${brand}</p>
<p style="${MAIL_BASE_STYLE.p}">${en ? 'Hi there,' : '你好,'}</p>
<p style="${MAIL_BASE_STYLE.p}">${en ? `You have been invited to join <strong>${mailBrand.brandEn}</strong>. Click the button below to set your admin password (valid for ` : `你被邀请加入<strong>${mailBrand.brand}</strong>。点击下方按钮设置登录密码(链接 `}${params.ttlMinutes}${en ? ' minutes, one-time use):' : ' 分钟内有效,仅可使用一次):'}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<a href="${url}" style="${STYLE.btn}">${en ? 'Set password' : '设置密码'}</a>
</td></tr><tr><td align="center">
<p style="${STYLE.link}">${en ? 'Or copy this link:' : '或复制链接:'}<br/>${url}</p>
</td></tr></table>
<p style="${MAIL_BASE_STYLE.p}">${en ? 'The link only sets your initial password. If it has expired, ask an administrator to resend the invitation.' : '该链接仅用于设置初始密码。若已过期,请联系管理员重新发送邀请邮件。'}</p>
<p style="${MAIL_BASE_STYLE.p}">${en ? `This email contains a one-time link. Do not forward it. Need help? <a href="mailto:support@tillgate.com" style="${MAIL_BASE_STYLE.link}">Contact support</a>.` : `本邮件含一次性链接,请勿转发给他人。需要帮助请<a href="mailto:support@tillgate.com" style="${MAIL_BASE_STYLE.link}">联系支持</a>。`}</p>
<p style="${MAIL_BASE_STYLE.sign}">${en ? 'Best,' : '顺祝,'}<br/>${brand} ${en ? 'Team' : '团队'}</p>
<p style="${MAIL_BASE_STYLE.sub}">${mailBrand.brandSub} · ${en ? 'Automated account security email. Do not reply.' : '账号安全自动邮件,请勿回复。'}</p>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject, text, html };
}
