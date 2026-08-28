/**
 * 验证码邮件投递 port。渲染见 templates/login-code-email.ts(纯函数);
 * 实现见 adapters/smtp/nodemailer-mailer.ts。缺省不装配 = 邮件通道 fail-closed
 * (begin-challenge 对 email 目标直接 undeliverable,不静默降级)。
 */
export interface Mailer {
  /**
   * 发送验证码(locale 跟随触发请求,默认英文;ip 用于邮件内来源提示)。
   * purpose 区分用途文案:login=登录/注册(缺省);two_factor_toggle=管理端
   * 「邮箱验证码二次登录」开关确认(admin-email-2fa)。
   */
  sendLoginCode(
    to: string,
    code: string,
    ctx: { ip: string; locale?: 'en' | 'zh'; purpose?: 'login' | 'two_factor_toggle' },
  ): Promise<void>;
  /** 发送找回密码一次性链接(url 由消费方按部署基地址拼装;ttlMinutes 随邮件展示) */
  sendPasswordResetLink(
    to: string,
    url: string,
    ctx: { ip: string; locale?: 'en' | 'zh'; ttlMinutes: number },
  ): Promise<void>;
  /** 发送管理员邀请链接(新建管理员设置初始密码;触发者是管理端操作而非
   * 最终用户请求,故不带 ip 来源提示) */
  sendAdminInviteLink(
    to: string,
    url: string,
    ctx: { locale?: 'en' | 'zh'; ttlMinutes: number },
  ): Promise<void>;
}
