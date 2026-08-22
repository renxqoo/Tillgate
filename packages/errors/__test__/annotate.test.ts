import { describe, expect, it } from 'vitest';

import { defineErrorCatalog } from '../src/definition';
import { recordOf } from '../src/error-record';
import { annotate, annotationsOf, BusinessError, type TokenlensError } from '../src/nature';

/**
 * 传播注记（ADR-0001 D9b）：错误上浮途中实例稳定地累积语境。
 * 合同：同一实例返回（instanceof/分类不动）；构造上下文为底、注记按时间序合并、
 * 后写胜出；符号键非枚举（序列化不被污染）。
 */

const FlowErrors = defineErrorCatalog('flow', {
  denied: { category: 'conflict', message: 'denied', zh: '拒绝' },
});

/** 固化类经注记后仍可精确捕获（对比 anyhow 包装式 context 丢失 downcast） */
class DeniedError extends BusinessError {
  constructor() {
    super(FlowErrors.entry('denied'));
  }
}

describe('annotate 传播注记', () => {
  it('返回同一实例：instanceof、分类、身份全程不动', () => {
    const original = new DeniedError();
    const returned = annotate(original, { requestId: 'r-1' });
    expect(returned).toBe(original);
    expect(returned).toBeInstanceOf(DeniedError);
    expect(returned.code).toBe('flow.denied');
    expect(returned.category).toBe('conflict');
  });

  it('记录合并：构造上下文为底，注记键追加、冲突时后写胜出', () => {
    const e = annotate(
      annotate(FlowErrors.business('denied', { needed: 5 }), { requestId: 'r-1' }),
      { requestId: 'r-2', channelId: 'ch-9' },
    );
    expect(recordOf(e).context).toEqual({ needed: 5, requestId: 'r-2', channelId: 'ch-9' });
  });

  it('无构造上下文时注记独立成录；无注记无上下文保持 undefined', () => {
    const annotated = annotate(FlowErrors.business('denied'), { requestId: 'r-1' });
    expect(recordOf(annotated).context).toEqual({ requestId: 'r-1' });
    expect(recordOf(FlowErrors.business('denied')).context).toBeUndefined();
  });

  it('注记存于符号键且非枚举：展开/序列化不被污染', () => {
    const e = annotate(FlowErrors.business('denied'), { requestId: 'r-1' });
    const symbols = Object.getOwnPropertySymbols(e);
    expect(symbols).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(e, symbols[0] as symbol)?.enumerable).toBe(false);
    expect('requestId' in { ...e }).toBe(false);
  });

  it('annotationsOf：按时间序返回；无注记为空数组（内部读取面）', () => {
    const e = annotate(annotate(new DeniedError(), { first: 1 }), { second: 2 });
    const e2: TokenlensError = FlowErrors.business('denied');
    expect(annotationsOf(e)).toEqual([{ first: 1 }, { second: 2 }]);
    expect(annotationsOf(e2)).toEqual([]);
  });
});
