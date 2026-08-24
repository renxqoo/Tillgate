/**
 * 找回密码邮件渲染双语锁定（覆盖率门禁补测，铁律 16 只补测试）：
 * 中英两 locale 的 subject/text/html 关键片段与安全口径（链接承载、无凭据旁泄）逐项断言。
 */
import { describe, expect, it } from 'vitest';
import { renderPasswordResetEmail } from '../src/templates/password-reset-email.js';

const brand = { brand: '测试品牌', brandEn: 'TestBrand' } as never;

describe('renderPasswordResetEmail(双语模板)', () => {
  it('默认英文:主题/正文含链接与有效期,html 为按钮形态', () => {
    const m = renderPasswordResetEmail('https://x.test/reset?t=1', { ip: '1.2.3.4' }, brand, {
      ttlMinutes: 15,
    });
    expect(m.subject).toBe('[TestBrand] Reset your password (15 min)');
    expect(m.text).toContain('https://x.test/reset?t=1');
    expect(m.text).toContain('valid for 15 minutes');
    expect(m.text).toContain('IP: 1.2.3.4');
    expect(m.html).toContain('lang="en"');
    expect(m.html).toContain('https://x.test/reset?t=1');
  });

  it('中文 locale:主题/正文/html 全量中文化', () => {
    const m = renderPasswordResetEmail(
      'https://x.test/reset?t=2',
      { ip: '5.6.7.8', locale: 'zh' },
      brand,
      { ttlMinutes: 30 },
    );
    expect(m.subject).toBe('【测试品牌】找回密码(30 分钟内有效)');
    expect(m.text).toContain('找回密码');
    expect(m.text).toContain('30 分钟内有效');
    expect(m.text).toContain('IP:5.6.7.8');
    expect(m.html).toContain('lang="zh-CN"');
    expect(m.html).toContain('https://x.test/reset?t=2');
  });

  it('两 locale 均不携带除链接外的任何凭据形态', () => {
    for (const locale of ['en', 'zh'] as const) {
      const m = renderPasswordResetEmail('https://x.test/r', { ip: '0.0.0.0', locale }, brand, {
        ttlMinutes: 10,
      });
      expect(m.text).not.toMatch(/code|验证码|旧密码|password:/i);
      expect(m.text).not.toMatch(/code|验证码|旧密码/i);
    }
  });
});
