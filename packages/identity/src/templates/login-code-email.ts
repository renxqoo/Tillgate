/**
 * 验证码邮件渲染纯函数(中英双语,locale 跟随触发请求,默认英文)。
 * 兼容性约定(QQ/163/Gmail/Outlook 通用):table 布局 + 全内联样式(多数客户端剔除
 * <style>),同时给 text(纯文本兜底)与 html。品牌口径:管理面与用户面各自注入。
 */

export interface MailBrand {
  /** 邮件品牌名(中文),如「Tillgate 管理后台」 */
  readonly brand: string;
  /** 邮件品牌名(英文) */
  readonly brandEn: string;
  /** 头部副标题,如「TILLGATE · ADMIN CONSOLE」 */
  readonly brandSub: string;
}

export interface LoginCodeEmailContext {
  /** 验证码有效期(分钟,随挑战 ttl 装配传入) */
  readonly ttlMinutes: number;
  /** 邮件内提示的错次上限(随挑战 maxAttempts) */
  readonly maxAttempts: number;
}

/** 邮件基础样式单源(极简白卡口径,与 password-reset-email 共用):
 * 白底卡片 + 浅灰细边框 + 圆角 12px,黑色粗体品牌名置顶,正文 16px 深灰,
 * 验证码 32px 加粗等宽,链接仅下划线强调;table + 全内联保邮件客户端兼容。 */
export const MAIL_BASE_STYLE = {
  pageBg: 'background:#ffffff;',
  card: 'background:#ffffff;border:1px solid #f0f0f0;border-radius:12px;max-width:480px;width:100%;',
  body: 'padding:40px 44px;',
  logo: 'color:#000000;font-size:24px;font-weight:700;letter-spacing:-0.5px;margin:0 0 28px;',
  p: 'color:#333333;font-size:16px;font-weight:400;line-height:1.5;margin:0 0 14px;',
  code: "color:#333333;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:-0.5px;margin:16px 0;",
  link: 'color:#333333;text-decoration:underline;',
  sign: 'color:#333333;font-size:16px;line-height:1.5;margin:0;',
  sub: 'color:#9ca3af;font-size:11px;line-height:1.8;margin:8px 0 0;',
} as const;

/** 邮件正文字体族(卡片与 body 共用) */
export const MAIL_FONT_FAMILY =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif;";

/** 用途×语言文案(标题词 + 引导句)——查表替分支堆叠(铁律 22 ②);
 * two_factor_toggle=管理端「邮箱验证码二次登录」开关确认(admin-email-2fa)。 */
function copyOf(
  en: boolean,
  toggle: boolean,
  brand: string,
): { subjectWord: string; intro: string } {
  if (toggle) {
    return en
      ? {
          subjectWord: 'Security confirmation code',
          intro: `You are changing the email second-factor sign-in setting of ${brand}. Confirm with the following code:`,
        }
      : {
          subjectWord: '安全确认码',
          intro: `你正在变更${brand}「邮箱验证码二次登录」设置,请使用以下验证码确认:`,
        };
  }
  return en
    ? {
        subjectWord: 'Login verification code',
        intro: `You are signing in to ${brand}. Use the following code to complete the verification:`,
      }
    : {
        subjectWord: '登录验证码',
        intro: `你正在登录${brand},请使用以下验证码完成验证:`,
      };
}

/** 渲染验证码邮件(subject + text + html);时间格式化由 now 注入(可测)。
 * purpose 区分用途文案(login 缺省;two_factor_toggle=管理端 2FA 开关确认)。 */
// eslint-disable-next-line max-params, max-lines-per-function -- 渲染入参五要素各有其位(公共导出,调用方按位置参数锁定);双语邮件模板 text/html 逐行平铺属数据渲染
export function renderLoginCodeEmail(
  code: string,
  ctx: { ip: string; locale?: 'en' | 'zh'; purpose?: 'login' | 'two_factor_toggle' },
  mailBrand: MailBrand,
  params: LoginCodeEmailContext,
  now: Date,
): { subject: string; text: string; html: string } {
  const en = ctx.locale !== 'zh';
  const { brandSub, ttlMinutes, maxAttempts } = { ...mailBrand, ...params };
  const brand = en ? mailBrand.brandEn : mailBrand.brand;
  const sentAt = now.toLocaleString(en ? 'en-US' : 'zh-CN', { hour12: false });
  const copy = copyOf(en, ctx.purpose === 'two_factor_toggle', brand);

  const subject = en ? `[${brand}] ${copy.subjectWord} ${code}` : `【${brand}】${copy.subjectWord} ${code}`;

  const text = en
    ? [
        `[${brand}]`,
        '',
        copy.intro,
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
        copy.intro,
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
<body style="margin:0;padding:0;${MAIL_BASE_STYLE.pageBg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${MAIL_BASE_STYLE.pageBg}padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="${MAIL_BASE_STYLE.card}${MAIL_FONT_FAMILY}">
<tr><td style="${MAIL_BASE_STYLE.body}">

<p style="${MAIL_BASE_STYLE.logo}">${brand}</p>
<p style="${MAIL_BASE_STYLE.p}">${en ? 'Hi there,' : '你好,'}</p>
<p style="${MAIL_BASE_STYLE.p}">${copy.intro}</p>
<p style="${MAIL_BASE_STYLE.code}">${code}</p>
<p style="${MAIL_BASE_STYLE.p}">${en ? `The code is valid for <strong>${ttlMinutes} minutes</strong>; <strong>${maxAttempts}</strong> failed attempts invalidate it.` : `验证码 <strong>${ttlMinutes} 分钟内</strong>有效,连续输错 <strong>${maxAttempts} 次</strong>将作废。`}</p>
<p style="${MAIL_BASE_STYLE.p}">${en ? `If this was not you, <a href="mailto:support@tillgate.com" style="${MAIL_BASE_STYLE.link}">contact support</a> or change your password immediately.` : `若非你本人操作,请 <a href="mailto:support@tillgate.com" style="${MAIL_BASE_STYLE.link}">联系支持</a>或立即修改密码。`}</p>
<p style="${MAIL_BASE_STYLE.sign}">${en ? 'Best,' : '顺祝,'}<br/>${brand} ${en ? 'Team' : '团队'}</p>
<p style="${MAIL_BASE_STYLE.sub}">${brandSub} · ${en ? `Source IP: ${ctx.ip} · Sent at: ${sentAt} · Do not reply` : `来源 IP:${ctx.ip} · 发送时间:${sentAt} · 请勿回复`}</p>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}
