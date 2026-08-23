/**
 * 验证码邮件投递 port。渲染见 templates/login-code-email.ts(纯函数);
 * 实现见 adapters/smtp/nodemailer-mailer.ts。缺省不装配 = 邮件通道 fail-closed
 * (begin-challenge 对 email 目标直接 undeliverable,不静默降级,B12)。
 */
export interface Mailer {
  /** 发送登录/注册验证码(locale 跟随触发请求,默认英文;ip 用于邮件内来源提示) */
  sendLoginCode(to: string, code: string, ctx: { ip: string; locale?: 'en' | 'zh' }): Promise<void>;
}
