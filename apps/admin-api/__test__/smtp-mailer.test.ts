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
      emailParams: { ttlMinutes: 5, maxAttempts: 5 },
      now: () => new Date(0),
    });
    await mailer.sendLoginCode('ops@tillgate.dev', '123456', { ip: '1.2.3.4', locale: 'zh' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'no-reply@tillgate.dev', to: 'ops@tillgate.dev' });
    expect(String(defined(sent[0], 'sent[0]').subject).length).toBeGreaterThan(0);
    expect(String(defined(sent[0], 'sent[0]').html)).toContain('123456');
  });
});
