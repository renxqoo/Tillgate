/**
 * 告警邮件发送 port:运维告警文本邮件(to/subject/text 平面三参)。
 * 实现为 adapters/smtp(nodemailer);装配缺省 undefined = email 渠道 fail-closed。
 * 登录验证码邮件归 identity 包,不在此。
 */
export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}
