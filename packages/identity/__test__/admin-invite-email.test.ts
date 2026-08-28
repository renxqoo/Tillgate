/**
 * 管理员邀请邮件渲染双语锁定：
 * 中英两 locale 的 subject/text/html 关键片段与安全口径（链接承载、无凭据旁泄、
 * 「设置初始密码」而非「找回」措辞——收件人尚无密码）逐项断言。
 */
import { describe, expect, it } from 'vitest';
import { renderAdminInviteEmail } from '../src/templates/admin-invite-email.js';

const brand = { brand: '测试后台', brandEn: 'TestBrand' } as never;

describe('renderAdminInviteEmail(双语模板)', () => {
  it('默认英文:主题/正文含链接与有效期,html 为按钮形态', () => {
    const m = renderAdminInviteEmail('https://x.test/reset-password?token=a', {}, brand, {
      ttlMinutes: 30,
    });
    expect(m.subject).toBe('[TestBrand] Set your admin password (30 min)');
    expect(m.text).toContain('https://x.test/reset-password?token=a');
    expect(m.text).toContain('valid for 30 minutes');
    expect(m.html).toContain('lang="en"');
    expect(m.html).toContain('https://x.test/reset-password?token=a');
  });

  it('中文 locale:主题/正文/html 全量中文化', () => {
    const m = renderAdminInviteEmail(
      'https://x.test/reset-password?token=b',
      { locale: 'zh' },
      brand,
      { ttlMinutes: 30 },
    );
    expect(m.subject).toBe('【测试后台】设置管理后台密码(30 分钟内有效)');
    expect(m.text).toContain('设置登录密码');
    expect(m.text).toContain('30 分钟内有效');
    expect(m.html).toContain('lang="zh-CN"');
    expect(m.html).toContain('https://x.test/reset-password?token=b');
  });

  it('两 locale 均不携带除链接外的任何凭据形态', () => {
    for (const locale of ['en', 'zh'] as const) {
      const m = renderAdminInviteEmail('https://x.test/r', { locale }, brand, { ttlMinutes: 10 });
      expect(m.text).not.toMatch(/code|验证码|旧密码|password:/i);
    }
  });
});
