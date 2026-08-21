import { describe, expect, it } from 'vitest';

import { renderLoginCodeEmail, ADMIN_MAIL_BRAND, USER_MAIL_BRAND } from '../mailer.js';

/**
 * 验证码邮件渲染（品牌 + 语言参数化）：企业级 HTML + 纯文本兜底。
 * 纯函数只测内容不测发信——SMTP 行为由真实邮箱人工验证。
 * 默认英文（locale 缺省），zh 显式传入。
 */

const CODE = '768518';

describe('renderLoginCodeEmail', () => {
  it('默认英文：验证码、有效期、错误次数、来源 IP、勿回复（管理后台品牌缺省）', () => {
    const rendered = renderLoginCodeEmail(CODE, { ip: '203.0.113.10' });
    expect(rendered.text).toContain(CODE);
    expect(rendered.text).toContain('5 minutes');
    expect(rendered.text).toContain('203.0.113.10');
    expect(rendered.text).toContain('Do not reply');
    expect(rendered.text).toContain('not you');
    expect(rendered.subject).toContain(ADMIN_MAIL_BRAND.brandEn);
  });

  it('默认英文 HTML：内联样式、大号验证码块、品牌与页脚信息齐全', () => {
    const html = renderLoginCodeEmail(CODE, { ip: '203.0.113.10' }).html;
    expect(html).toContain(ADMIN_MAIL_BRAND.brandEn);
    expect(html).toContain(ADMIN_MAIL_BRAND.brandSub);
    expect(html).toContain(CODE);
    expect(html).toContain('5 minutes');
    expect(html).toContain('203.0.113.10');
    expect(html).toContain('Do not reply');
    expect(html).not.toContain(USER_MAIL_BRAND.brandEn);
    expect(html).not.toContain(USER_MAIL_BRAND.brand);
  });

  it('zh：中文口径全量（品牌、正文、页脚）', () => {
    const rendered = renderLoginCodeEmail(CODE, { ip: '203.0.113.10', locale: 'zh' });
    expect(rendered.subject).toContain(ADMIN_MAIL_BRAND.brand);
    expect(rendered.subject).toContain('登录验证码');
    expect(rendered.text).toContain('5 分钟');
    expect(rendered.text).toContain('5 次');
    expect(rendered.text).toContain('来源 IP：203.0.113.10');
    expect(rendered.text).toContain('请勿回复');
    expect(rendered.html).toContain('登录验证码');
    expect(rendered.html).toContain('请勿回复');
    expect(rendered.html).not.toContain('Do not reply');
  });

  it('用户面板品牌：标题/副标题切换，内容口径一致', () => {
    const rendered = renderLoginCodeEmail(CODE, { ip: '198.51.100.7' }, USER_MAIL_BRAND);
    expect(rendered.subject).toContain(USER_MAIL_BRAND.brandEn);
    expect(rendered.html).toContain(USER_MAIL_BRAND.brandSub);
    expect(rendered.html).toContain(CODE);
    expect(rendered.text).toContain('198.51.100.7');
    expect(rendered.html).not.toContain(ADMIN_MAIL_BRAND.brandEn);
  });
});
