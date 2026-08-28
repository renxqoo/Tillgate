import { describe, expect, it } from 'vitest';
import { BusinessError, defineErrorCatalog } from '@tillgate/errors';
import { HttpErrors } from '../src/errors/catalog';

/**
 * http 自有目录的行为锁：码集封闭、category 分布、business 构造。
 * 目录机制本身（冻结/形状校验/未知 key 防呆）由 errors 包测试覆盖，此处只锁本目录内容。
 */

describe('HttpErrors 目录内容', () => {
  it('码集封闭（19 码，装配即锁）', () => {
    expect([...HttpErrors.codes].toSorted()).toEqual([
      'http.db_budget_abandoned',
      'http.db_budget_draining',
      'http.db_budget_full',
      'http.db_budget_timeout',
      'http.invalid_idempotency_key',
      'http.invalid_json',
      'http.invalid_path_param',
      'http.invalid_request',
      'http.not_found',
      'http.payload_too_large',
      'http.pg_check_violation',
      'http.pg_fk_violation',
      'http.pg_invalid_text',
      'http.pg_numeric_out_of_range',
      'http.pg_unique_violation',
      'http.pg_value_too_long',
      'http.unauthorized',
      'http.unsupported_media_type',
      'http.validation_failed',
    ]);
  });

  it('get/has：命中与未命中', () => {
    expect(HttpErrors.get('http.validation_failed')).toEqual({
      category: 'invalid_input',
      message: 'Invalid request parameters',
      zh: '请求参数无效',
    });
    expect(HttpErrors.has('http.not_found')).toBe(true);
    expect(HttpErrors.has('http.unknown')).toBe(false);
    expect(HttpErrors.get('other.validation_failed')).toBeUndefined();
  });

  it('category 分布：唯一 conflict 是 pg_unique_violation；not_found 独占', () => {
    for (const code of HttpErrors.codes) {
      const category = HttpErrors.get(code)?.category;
      if (category === 'conflict') expect(code).toBe('http.pg_unique_violation');
    }
    expect(HttpErrors.get('http.not_found')?.category).toBe('not_found');
    expect(HttpErrors.get('http.payload_too_large')?.category).toBe('invalid_input');
  });

  it('business()：构造 BusinessError，身份/分类/文案来自定义，context 透传', () => {
    const err = HttpErrors.business('invalid_idempotency_key', { length: 200 });
    expect(err).toBeInstanceOf(BusinessError);
    expect(err.code).toBe('http.invalid_idempotency_key');
    expect(err.category).toBe('invalid_input');
    expect(err.message).toBe(
      'idempotency-key must be 1-64 characters of letters, digits, underscores or hyphens',
    );
    expect(err.context).toEqual({ length: 200 });
  });

  it('db-budget 取消族新码：abandoned/draining 双语与 category（db-budget-signals 方案）', () => {
    expect(HttpErrors.get('http.db_budget_abandoned')).toEqual({
      category: 'unavailable',
      message: 'DB concurrency budget wait abandoned, client disconnected',
      zh: '数据库并发预算等待已放弃（客户端已断开）',
    });
    expect(HttpErrors.get('http.db_budget_draining')).toEqual({
      category: 'unavailable',
      message: 'Server draining, DB concurrency budget closed, retry later',
      zh: '服务停机排水中，数据库并发预算已关闭，请稍后重试',
    });
  });
});

describe('face 目录装配形态（消费方式示例 + 防重语义）', () => {
  it('code() 生成点分身份码（编译期模板字面量）', () => {
    expect(HttpErrors.code('validation_failed')).toBe('http.validation_failed');
  });

  it('B6 回归：业务码不入 http 目录——能力包目录与 http 目录命名空间隔离可组合', () => {
    const Face = defineErrorCatalog('face_test', {
      session_invalid: { category: 'forbidden', message: 'Session invalid', zh: '会话无效' },
    });
    expect(Face.get('face_test.session_invalid')?.category).toBe('forbidden');
    expect(HttpErrors.get('face_test.session_invalid')).toBeUndefined();
  });
});
