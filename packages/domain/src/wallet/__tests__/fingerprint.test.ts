/** 命令指纹契约：等价规范化命令同摘要、非等价必不同、null 历史行容忍。 */
import { describe, expect, it } from 'vitest';
import { IdempotencyConflictError } from '../errors.js';
import { assertCommandFingerprint, commandFingerprint } from '../fingerprint.js';

describe('commandFingerprint（canonical 形态）', () => {
  it('对象键序无关：扁平与嵌套同构', () => {
    expect(commandFingerprint('k', { a: 1, b: 2 } as never)).toBe(
      commandFingerprint('k', { b: 2, a: 1 } as never),
    );
    expect(commandFingerprint('k', { x: { a: 1, b: [1, { q: 1, p: 2 }] }, y: null } as never)).toBe(
      commandFingerprint('k', { y: null, x: { b: [1, { p: 2, q: 1 }], a: 1 } } as never),
    );
  });

  it('数组保序（数组是有序集合，不排序）', () => {
    expect(commandFingerprint('k', { a: [1, 2, 3] } as never)).not.toBe(
      commandFingerprint('k', { a: [3, 2, 1] } as never),
    );
  });

  it('undefined 字段丢弃（缺省与显式 undefined 等价）', () => {
    expect(commandFingerprint('k', { a: 1, b: undefined } as never)).toBe(
      commandFingerprint('k', { a: 1 } as never),
    );
  });

  it('kind 参与摘要（同 payload 不同命令必不同）', () => {
    expect(commandFingerprint('credit', { a: 1 } as never)).not.toBe(
      commandFingerprint('settle', { a: 1 } as never),
    );
  });

  it('数值与字符串区分（类型不混淆）', () => {
    expect(commandFingerprint('k', { a: 1 } as never)).not.toBe(
      commandFingerprint('k', { a: '1' } as never),
    );
  });
});

describe('assertCommandFingerprint（幂等比对）', () => {
  const fp = commandFingerprint('credit', { a: 1 } as never);

  it('null（指纹引入前的历史行）容忍放行', () => {
    expect(() => assertCommandFingerprint(null, fp, 't', 'r', 'credit')).not.toThrow();
  });

  it('一致放行；不一致 → IdempotencyConflictError（409 语义）', () => {
    expect(() => assertCommandFingerprint(fp, fp, 't', 'r', 'credit')).not.toThrow();
    const other = commandFingerprint('credit', { a: 2 } as never);
    expect(() => assertCommandFingerprint(fp, other, 't', 'r', 'credit')).toThrow(
      IdempotencyConflictError,
    );
  });
});
