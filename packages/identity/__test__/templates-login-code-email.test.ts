/**
 * 验证码邮件渲染测试(v1 mailer.test 迁移):中英双语要素、HTML 内联样式、
 * 品牌与语言切换、时效参数注入、用途文案分支(admin-email-2fa:开关确认码
 * 与登录码区分——缺省 login 行为不变)。
 */
import { describe, expect, it } from 'vitest';
import { renderLoginCodeEmail, type MailBrand } from '../src/templates/login-code-email.js';

const BRAND: MailBrand = {
  brand: 'Tillgate 管理后台',
  brandEn: 'Tillgate Admin Console',
  brandSub: 'TILLGATE · ADMIN CONSOLE',
};
const NOW = new Date('2026-08-23T08:00:00Z');
const PARAMS = { ttlMinutes: 5, maxAttempts: 5 };

describe('renderLoginCodeEmail', () => {
  it('默认英文:要素齐全(码/时效/错次/IP/勿回复/品牌)', () => {
    const mail = renderLoginCodeEmail('654321', { ip: '203.0.113.1' }, BRAND, PARAMS, NOW);
    expect(mail.subject).toBe('[Tillgate Admin Console] Login verification code 654321');
    expect(mail.text).toContain('654321');
    expect(mail.text).toContain('5 minutes');
    expect(mail.text).toContain('5 failed attempts');
    expect(mail.text).toContain('Source IP: 203.0.113.1');
    expect(mail.text).toContain('Do not reply');
    expect(mail.text).not.toContain('验证码');
  });

  it('英文 HTML:内联样式 + 品牌 + 不含用户面文案', () => {
    const mail = renderLoginCodeEmail('654321', { ip: 'ip' }, BRAND, PARAMS, NOW);
    expect(mail.html).toContain('<!DOCTYPE html>');
    expect(mail.html).toContain('style="'); // 内联样式(邮件客户端剔除 <style> 的兼容口径)
    expect(mail.html).toContain('width="480"'); // 卡片宽度用 table 属性(QQ/Outlook 不支持 max-width 的兼容口径)
    expect(mail.html).toContain('TILLGATE · ADMIN CONSOLE');
    expect(mail.html).not.toContain('登录验证码');
  });

  it('中文全量且不含英文正文;locale 切换', () => {
    const mail = renderLoginCodeEmail(
      '654321',
      { ip: '198.51.100.2', locale: 'zh' },
      BRAND,
      PARAMS,
      NOW,
    );
    expect(mail.subject).toBe('【Tillgate 管理后台】登录验证码 654321');
    expect(mail.text).toContain('来源 IP:198.51.100.2');
    expect(mail.text).toContain('请勿回复');
    expect(mail.text).not.toContain('Do not reply');
    expect(mail.html).toContain('zh-CN');
  });

  it('品牌切换 + 时效参数注入(挑战配置不同值)', () => {
    const userBrand: MailBrand = {
      brand: 'Tillgate 用户面板',
      brandEn: 'Tillgate Console',
      brandSub: 'TILLGATE · CLIENT CONSOLE',
    };
    const mail = renderLoginCodeEmail(
      '111111',
      { ip: 'ip' },
      userBrand,
      { ttlMinutes: 10, maxAttempts: 3 },
      NOW,
    );
    expect(mail.subject).toContain('[Tillgate Console]');
    expect(mail.text).toContain('10 minutes');
    expect(mail.text).toContain('3 failed attempts');
  });

  it('purpose=two_factor_toggle(中英):标题与引导句按用途切换,其余要素不变', () => {
    const zh = renderLoginCodeEmail(
      '222222',
      { ip: 'ip', locale: 'zh', purpose: 'two_factor_toggle' },
      BRAND,
      PARAMS,
      NOW,
    );
    expect(zh.subject).toBe('【Tillgate 管理后台】安全确认码 222222');
    expect(zh.text).toContain('「邮箱验证码二次登录」设置,请使用以下验证码确认');
    expect(zh.text).not.toContain('你正在登录');

    const en = renderLoginCodeEmail(
      '222222',
      { ip: 'ip', purpose: 'two_factor_toggle' },
      BRAND,
      PARAMS,
      NOW,
    );
    expect(en.subject).toBe('[Tillgate Admin Console] Security confirmation code 222222');
    expect(en.text).toContain('changing the email second-factor sign-in setting');
    expect(en.html).toContain('second-factor sign-in setting');
  });

  it('purpose 缺省 = login(回归):不出现开关确认文案', () => {
    const mail = renderLoginCodeEmail('654321', { ip: 'ip', locale: 'zh' }, BRAND, PARAMS, NOW);
    expect(mail.subject).toContain('登录验证码');
    expect(mail.html).not.toContain('二次登录');
  });
});
