import { describe, expect, it } from 'vitest';
import { stripAuthParams } from './auth-url.js';

/** 登录族页面查询参数白名单清理：URL 不承载登录信息（凭证/令牌留痕面全堵）。 */
describe('stripAuthParams', () => {
  it('白名单外参数（email/password）→ 返回剥除后的干净 URL', () => {
    expect(
      stripAuthParams('/login', { email: 'a@b.c', password: 'pw', next: '/dashboard' }, ['next']),
    ).toBe('/login?next=%2Fdashboard');
  });

  it('只带白名单参数 → null（原样渲染，不重定向不循环）', () => {
    expect(stripAuthParams('/login', { next: '/dashboard' }, ['next'])).toBeNull();
    expect(stripAuthParams('/login', {}, ['next'])).toBeNull();
  });

  it('无白名单参数可保留 → 裸路径', () => {
    expect(
      stripAuthParams('/login', { email: 'a@b.c', password: 'x' }, []),
    ).toBe('/login');
  });

  it('白名单参数缺省/空值不保留', () => {
    expect(stripAuthParams('/login', { next: '', email: 'a@b.c' }, ['next'])).toBe('/login');
    expect(stripAuthParams('/login', { next: undefined, t: '1' }, ['next'])).toBe('/login');
  });

  it('数组值取首项（Next 同名参数折叠语义）', () => {
    // 仅白名单参数（即使为数组形态）不需要清理
    expect(stripAuthParams('/login', { next: ['/a', '/b'] }, ['next'])).toBeNull();
    // 因白名单外参数触发清理时，数组取首项
    expect(
      stripAuthParams('/login', { next: ['/a', '/b'], password: 'x' }, ['next']),
    ).toBe('/login?next=%2Fa');
  });

  it('参数值正确重编码（email 中的 @ 与中文）', () => {
    expect(
      stripAuthParams('/register', { email: 'u@例.com', from: 'x' }, []),
    ).toBe('/register');
    expect(
      stripAuthParams('/login', { next: '/路径?a=1&b=2', password: 'x' }, ['next']),
    ).toBe('/login?next=%2F%E8%B7%AF%E5%BE%84%3Fa%3D1%26b%3D2');
  });
});
