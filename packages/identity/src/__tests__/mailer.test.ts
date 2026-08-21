import { describe, expect, it } from 'vitest';

import { renderLoginCodeEmail, ADMIN_MAIL_BRAND, USER_MAIL_BRAND } from '../mailer.js';

/**
 * 验证码邮件渲染（品牌参数化）：企业级 HTML + 纯文本兜底。
 * 纯函数只测内容不测发信——SMTP 行为由真实邮箱人工验证。
 */

const CODE = '768518';

describe('renderLoginCodeEmail', () => {
  it('纯文本含验证码、有效期、错误次数、来源 IP、勿回复（管理后台品牌缺省）', () => {
    const rendered = renderLoginCodeEmail(CODE, { ip: '203.0.113.10' });
    expect(rendered.text).toContain(CODE);
    expect(rendered.text).toContain('5 分钟');
    expect(rendered.text).toContain('5 次');
    expect(rendered.text).toContain('203.0.113.10');
    expect(rendered.text).toContain('请勿回复');
    expect(rendered.text).toContain('非你本人操作');
    expect(rendered.subject).toContain(ADMIN_MAIL_BRAND.brand);
  });

  it('HTML：内联样式、大号验证码块、品牌与页脚信息齐全', () => {
    const html = renderLoginCodeEmail(CODE, { ip: '203.0.113.10' }).html;
    expect(html).toContain(ADMIN_MAIL_BRAND.brand);
    expect(html).toContain(ADMIN_MAIL_BRAND.brandSub);
    expect(html).toContain(CODE);
    expect(html).toContain('5 分钟内');
    expect(html).toContain('203.0.113.10');
    expect(html).toContain('请勿回复');
    expect(html).not.toContain(USER_MAIL_BRAND.brand);
  });

  it('用户面板品牌：标题/副标题切换，内容口径一致', () => {
    const rendered = renderLoginCodeEmail(CODE, { ip: '198.51.100.7' }, USER_MAIL_BRAND);
    expect(rendered.subject).toContain(USER_MAIL_BRAND.brand);
    expect(rendered.html).toContain(USER_MAIL_BRAND.brandSub);
    expect(rendered.html).toContain(CODE);
    expect(rendered.text).toContain('198.51.100.7');
    expect(rendered.html).not.toContain(ADMIN_MAIL_BRAND.brand);
  });
});
