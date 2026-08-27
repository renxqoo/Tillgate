import { describe, expect, it } from 'vitest';
import { buildCandidateChain } from '../src/domain/model/candidates';
import { mapping } from './harness';

describe('domain/model/candidates：主模型 + fallback 一级展开', () => {
  it('主映射在前，fallback 依序解析追加（价格快照取各自映射）', async () => {
    const main = mapping({
      mappingId: 1,
      externalModel: 'm',
      fallbackModels: ['fb-1', 'fb-2'],
    });
    const chain = await buildCandidateChain(main, async (external) =>
      external === 'fb-1'
        ? mapping({ mappingId: 2, externalModel: 'fb-1', realModel: 'r2', outputPrice: '9' })
        : mapping({ mappingId: 3, externalModel: 'fb-2', realModel: 'r3', outputPrice: '10' }),
    );
    expect(chain.map((c) => c.mappingId)).toEqual([1, 2, 3]);
    expect(chain[1]).toMatchObject({ realModel: 'r2', outputPrice: '9' });
    expect(chain[2]).toMatchObject({ realModel: 'r3', outputPrice: '10' });
  });

  it('解析不到的 fallback 跳过（目录缺失不阻断链）', async () => {
    const main = mapping({ fallbackModels: ['missing', 'hit'] });
    const chain = await buildCandidateChain(main, async (external) =>
      external === 'hit' ? mapping({ mappingId: 9, externalModel: 'hit' }) : null,
    );
    expect(chain.map((c) => c.mappingId)).toEqual([11, 9]);
  });

  it('mappingId 去重：同一映射经两条名到达只计一次', async () => {
    const main = mapping({ mappingId: 1, fallbackModels: ['same', 'same2'] });
    const chain = await buildCandidateChain(main, async () =>
      mapping({ mappingId: 5, externalModel: 'dup' }),
    );
    expect(chain.map((c) => c.mappingId)).toEqual([1, 5]);
  });

  it('不递归：fallback 自身的 fallbackModels 不展开（无界链防御）', async () => {
    const main = mapping({ mappingId: 1, fallbackModels: ['fb'] });
    const fb = mapping({ mappingId: 2, externalModel: 'fb', fallbackModels: ['fb-of-fb'] });
    const chain = await buildCandidateChain(main, async (external) =>
      external === 'fb' ? fb : mapping({ mappingId: 3, externalModel: 'fb-of-fb' }),
    );
    expect(chain.map((c) => c.mappingId)).toEqual([1, 2]);
  });

  it('无 fallback 时链 = [主映射]', async () => {
    const chain = await buildCandidateChain(mapping(), async () => mapping());
    expect(chain).toHaveLength(1);
  });
});

describe('限流限额透传（S4 列贯通——admitModel 消费的字段）', () => {
  it('主/fallback 候选各带自己的 rpm/tpm 限额；null 形态不带字段', async () => {
    const chain = await buildCandidateChain(
      mapping({ fallbackModels: ['fb'], rpmLimit: 60, tpmLimit: 90_000 }),
      async () =>
        mapping({
          mappingId: 12,
          externalModel: 'fb',
          realModel: 'fb-real',
          rpmLimit: 30,
          tpmLimit: null,
        }),
    );
    expect(chain[0]).toMatchObject({ rpmLimit: 60, tpmLimit: 90_000 });
    expect(chain[1]).toMatchObject({ rpmLimit: 30 });
    expect(chain[1]).not.toHaveProperty('tpmLimit'); // null → 字段省略（钩子侧 ?? null 归一）
  });
});
