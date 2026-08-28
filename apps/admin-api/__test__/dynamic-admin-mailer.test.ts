/**
 * 动态管理面邮件（集成设置驱动）单元规格（mock nodemailer + stub reader；
 * 独立文件——vi.resetModules 换代模块注册表，与错误面渲染测试互不污染）。
 * 规格锁:发送面走 resolve() 严格读；SMTP 未生效 =
 * undeliverable_challenge；传输器随配置指纹重建（同指纹复用、变指纹重建）；
 * 管理面不发找回链接（端口合规空实现）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { IntegrationSnapshot, IntegrationSettingsReader } from '@tillgate/control-plane';
import type { MailBrand } from '@tillgate/identity';
import { defined } from './defined.js';

type SmtpFace = IntegrationSnapshot['smtp'];

const SMTP_OFF: SmtpFace = {
  configured: false,
  enabled: false,
  effective: false,
  config: null,
};

const SMTP_ON = (port: number): SmtpFace => ({
  configured: true,
  enabled: true,
  effective: true,
  config: { host: 'smtp.example', port, user: 'ops', pass: 'p', from: 'no-reply@tillgate.dev' },
});

const BRAND: MailBrand = {
  brand: 'Tillgate 管理后台',
  brandEn: 'Tillgate Admin',
  brandSub: 'TILLGATE · ADMIN CONSOLE',
};

/** 可变快照 stub reader——resolve 计数锁「发送面严格读」 */
function stubReader() {
  const state = { smtp: SMTP_OFF as SmtpFace, resolveCalls: 0 };
  const reader = {
    resolve: async (): Promise<IntegrationSnapshot> => {
      state.resolveCalls += 1;
      return { smtp: state.smtp } as IntegrationSnapshot;
    },
  };
  return { state, reader: reader as unknown as IntegrationSettingsReader };
}

async function buildMailer(reader: IntegrationSettingsReader) {
  const transports: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  vi.doMock('nodemailer', () => ({
    default: {
      createTransport: (opts: Record<string, unknown>) => {
        transports.push(opts);
        return {
          get options() {
            return opts;
          },
          sendMail: async (mail: Record<string, unknown>) => {
            sent.push(mail);
          },
        };
      },
    },
    createTransport: (opts: Record<string, unknown>) => {
      transports.push(opts);
      return { sendMail: async (mail: Record<string, unknown>) => sent.push(mail) };
    },
  }));
  vi.resetModules();
  const { createDynamicAdminMailer } = await import('../src/adapters/dynamic-admin-mailer');
  const mailer = createDynamicAdminMailer({
    reader,
    brand: BRAND,
    inviteParams: { ttlMinutes: 30 },
    emailParams: { ttlMinutes: 5, maxAttempts: 5 },
    now: () => new Date(0),
  });
  return { mailer, transports, sent };
}

describe('dynamic-admin-mailer（集成设置驱动）', () => {
  it('SMTP 未配置/未生效 → undeliverable_challenge（发送面 fail-loud，不静默降级）', async () => {
    const { state, reader } = stubReader();
    const { mailer } = await buildMailer(reader);
    // 未配置（config = null）
    await expect(
      mailer.sendLoginCode('ops@tillgate.dev', '123456', { ip: '1.2.3.4', locale: 'zh' }),
    ).rejects.toMatchObject({ code: 'identity.undeliverable_challenge' });
    // 已配置但停用（config 在、effective false）
    state.smtp = { ...SMTP_ON(465), effective: false };
    await expect(
      mailer.sendLoginCode('ops@tillgate.dev', '123456', { ip: '1.2.3.4', locale: 'zh' }),
    ).rejects.toMatchObject({ code: 'identity.undeliverable_challenge' });
  });

  it('生效 → 委托 smtp-admin-mailer 发送；同指纹复用传输器（resolve 严格读每次快照）', async () => {
    const { state, reader } = stubReader();
    state.smtp = SMTP_ON(465);
    const { mailer, transports, sent } = await buildMailer(reader);
    const ctx = { ip: '1.2.3.4', locale: 'zh' as const };
    await mailer.sendLoginCode('ops@tillgate.dev', '111111', ctx);
    await mailer.sendLoginCode('ops@tillgate.dev', '222222', ctx);
    expect(sent).toHaveLength(2);
    expect(transports).toHaveLength(1); // 同指纹不重建
    expect(sent[0]).toMatchObject({ from: 'no-reply@tillgate.dev', to: 'ops@tillgate.dev' });
    expect(String(defined(sent[1], 'sent[1]').html)).toContain('222222');
  });

  it('配置变更（指纹变化）→ 重建传输器', async () => {
    const { state, reader } = stubReader();
    state.smtp = SMTP_ON(465);
    const { mailer, transports } = await buildMailer(reader);
    const ctx = { ip: '1.2.3.4', locale: 'zh' as const };
    await mailer.sendLoginCode('ops@tillgate.dev', '111111', ctx);
    state.smtp = SMTP_ON(587); // 指纹变化（端口不同）
    await mailer.sendLoginCode('ops@tillgate.dev', '222222', ctx);
    expect(transports).toHaveLength(2);
  });

  it('管理面不发找回链接（端口合规空实现）', async () => {
    const { reader } = stubReader();
    const { mailer } = await buildMailer(reader);
    await expect(
      mailer.sendPasswordResetLink('ops@tillgate.dev', 'https://x', {
        ip: '1.2.3.4',
        ttlMinutes: 15,
      }),
    ).rejects.toThrow(/does not send reset links/);
  });

  it('管理员邀请:生效即发送(模板渲染链接);未生效同码 undeliverable_challenge', async () => {
    const { state, reader } = stubReader();
    state.smtp = SMTP_ON(465);
    const { mailer, sent } = await buildMailer(reader);
    const url = 'https://admin.example.com/reset-password?token=t';
    await mailer.sendAdminInviteLink('new@tillgate.dev', url, { locale: 'zh', ttlMinutes: 30 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'new@tillgate.dev' });
    expect(String(defined(sent[0], 'sent[0]').html)).toContain('设置登录密码');

    state.smtp = SMTP_OFF;
    await expect(
      mailer.sendAdminInviteLink('new@tillgate.dev', url, { locale: 'zh', ttlMinutes: 30 }),
    ).rejects.toMatchObject({ code: 'identity.undeliverable_challenge' });
  });
});
