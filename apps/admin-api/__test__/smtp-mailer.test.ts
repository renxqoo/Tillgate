/**
 * smtp-admin-mailer 装配面传输件（mock nodemailer;独立文件——vi.resetModules
 * 会换代模块注册表,与错误面渲染测试互不污染）。
 */
import { describe, expect, it, vi } from 'vitest';
import { defined } from './defined.js';

describe('smtp-admin-mailer（装配面传输件）', () => {
  it('三要素构建传输;sendLoginCode 渲染模板经 nodemailer 发送（465=secure）', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const createTransport = (opts: Record<string, unknown>) => ({
      get options() {
        return opts;
      },
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
      },
    });
    vi.doMock('nodemailer', () => ({ default: { createTransport }, createTransport }));
    vi.resetModules();
    const { createSmtpAdminMailer } = await import('../src/adapters/smtp-admin-mailer');
    const mailer = createSmtpAdminMailer({
      config: {
        host: 'smtp.example',
        port: 465,
        user: 'ops',
        pass: 'p',
        from: 'no-reply@tillgate.dev',
      },
      brand: {
        brand: 'Tillgate 管理后台',
        brandEn: 'Tillgate Admin',
        brandSub: 'TILLGATE · ADMIN CONSOLE',
      },
      inviteParams: { ttlMinutes: 30 },
      emailParams: { ttlMinutes: 5, maxAttempts: 5 },
      now: () => new Date(0),
    });
    await mailer.sendLoginCode('ops@tillgate.dev', '123456', { ip: '1.2.3.4', locale: 'zh' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'no-reply@tillgate.dev', to: 'ops@tillgate.dev' });
    expect(String(defined(sent[0], 'sent[0]').subject).length).toBeGreaterThan(0);
    expect(String(defined(sent[0], 'sent[0]').html)).toContain('123456');

    // 邀请邮件:链接模板渲染(设置初始密码 + 30 分钟有效),链接原样承载
    const url = 'https://admin.example.com/reset-password?token=abc';
    await mailer.sendAdminInviteLink('new@tillgate.dev', url, { locale: 'zh', ttlMinutes: 30 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ from: 'no-reply@tillgate.dev', to: 'new@tillgate.dev' });
    expect(String(defined(sent[1], 'sent[1]').subject)).toContain('设置管理后台密码');
    expect(String(defined(sent[1], 'sent[1]').html)).toContain(url);
  });
});
