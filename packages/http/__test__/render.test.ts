import { describe, expect, it } from 'vitest';
import { DefectError, InfrastructureError, defineErrorCatalog } from '@tillgate/errors';
import { CATEGORY_STATUS_DEFAULTS, renderError } from '../src/errors/render';
import { HttpErrors } from '../src/errors/catalog';

/**
 * 渲染分派（v1 errors.test / error-locale.test 可迁移断言的重写形态）：
 * business 三级 status 链、双语文案、context/retryAfterMs 透传、
 * infrastructure 503 原码、defect/未知 500 细节不外泄（内外分际）。
 */

const Face = defineErrorCatalog('render_test', {
  session_invalid: {
    category: 'forbidden',
    message: 'Session invalid or expired',
    zh: '会话无效或已过期',
  },
  insufficient_cash: {
    category: 'quota_exhausted',
    message: 'Insufficient balance',
    zh: '余额不足',
  },
  throttled: { category: 'rate_limited', message: 'Too many requests', zh: '请求过于频繁' },
});

describe('CATEGORY_STATUS_DEFAULTS：category → 默认出站 status（http 侧补位）', () => {
  it('七项闭集全表', () => {
    expect(CATEGORY_STATUS_DEFAULTS).toEqual({
      invalid_input: 400,
      not_found: 404,
      conflict: 409,
      forbidden: 403,
      quota_exhausted: 402,
      rate_limited: 429,
      unavailable: 503,
    });
  });
});

describe('renderError：business 分支', () => {
  it('status 按 category 默认派生', () => {
    expect(renderError(Face.business('session_invalid'), { catalog: Face }).status).toBe(403);
    expect(renderError(Face.business('insufficient_cash'), { catalog: Face }).status).toBe(402);
    expect(renderError(Face.business('throttled'), { catalog: Face }).status).toBe(429);
    expect(renderError(HttpErrors.business('not_found')).status).toBe(404);
    expect(renderError(HttpErrors.business('pg_unique_violation')).status).toBe(409);
  });

  it('http 自有码修正表：413/401/415 优先于 category 默认', () => {
    expect(renderError(HttpErrors.business('payload_too_large')).status).toBe(413);
    expect(renderError(HttpErrors.business('unauthorized')).status).toBe(401);
    expect(renderError(HttpErrors.business('unsupported_media_type')).status).toBe(415);
  });

  it('face override 优先级最高（status 与 wire code 双覆盖）', () => {
    const rendered = renderError(Face.business('session_invalid'), {
      catalog: Face,
      overrides: { 'render_test.session_invalid': { status: 401, code: 'unauthorized' } },
    });
    expect(rendered.status).toBe(401);
    expect(rendered.code).toBe('unauthorized');
  });

  it('文案按 locale 取目录定义：zh 取 zh、缺省/en 取 message', () => {
    expect(renderError(Face.business('session_invalid'), { catalog: Face }).message).toBe(
      'Session invalid or expired',
    );
    expect(
      renderError(Face.business('session_invalid'), { catalog: Face, locale: 'zh' }).message,
    ).toBe('会话无效或已过期');
    expect(renderError(HttpErrors.business('validation_failed'), { locale: 'zh' }).message).toBe(
      '请求参数无效',
    );
  });

  it('context 与 retryAfterMs 透传（出站安全面：context 契约 scalar-only）', () => {
    const err = Face.business(
      'insufficient_cash',
      { needed: '5.00', available: '3.00' },
      {
        retryAfterMs: 2_500,
      },
    );
    const rendered = renderError(err, { catalog: Face });
    expect(rendered.context).toEqual({ needed: '5.00', available: '3.00' });
    expect(rendered.retryAfterMs).toBe(2_500);
  });

  it('目录 miss（face 装配缺陷）→ 按缺陷渲染：500 + errors.unhandled + 通用文案', () => {
    // catalog 未提供该命名空间
    const rendered = renderError(Face.business('session_invalid'), { catalog: HttpErrors });
    expect(rendered.status).toBe(500);
    expect(rendered.code).toBe('errors.unhandled');
    expect(rendered.message).toBe('Internal server error');
  });
});

describe('renderError：infrastructure / defect / 未知（内外分际）', () => {
  it('infrastructure → 503 + 身份码保留 + 通用文案（内部诊断不外泄）', () => {
    const err = new InfrastructureError(
      'connect ECONNREFUSED 10.0.0.5:6379',
      'runtime.redis_unreachable',
    );
    const rendered = renderError(err);
    expect(rendered.status).toBe(503);
    expect(rendered.code).toBe('runtime.redis_unreachable');
    expect(rendered.message).toBe('Service temporarily unavailable');
    expect(rendered.message).not.toContain('10.0.0.5');
    expect(renderError(err, { locale: 'zh' }).message).toBe('服务暂时不可用');
  });

  it('defect → 500 + errors.unhandled + 通用文案（细节不外泄）', () => {
    const err = new DefectError(
      'invariant broken: ledger legs diverged by 100',
      'billing.invariant',
    );
    const rendered = renderError(err);
    expect(rendered.status).toBe(500);
    expect(rendered.code).toBe('errors.unhandled');
    expect(rendered.message).toBe('Internal server error');
    expect(rendered.message).not.toContain('ledger');
  });

  it('外来 Error / 非 Error 值 → 一律按缺陷（errors.unhandled / errors.non_error 语义）', () => {
    expect(renderError(new Error('kaboom')).status).toBe(500);
    expect(renderError(new Error('kaboom')).code).toBe('errors.unhandled');
    expect(renderError('boom string').status).toBe(500);
    expect(renderError(undefined).status).toBe(500);
  });

  it('cause 链不改变渲染性质（谁检测谁分类，链式透明）', () => {
    const wrapped = new InfrastructureError('upstream relay failed', 'http.upstream', undefined, {
      cause: new Error('socket hang up'),
    });
    expect(renderError(wrapped).status).toBe(503);
  });
});
