/**
 * 绑定契约回归（双轨定价）：成本覆盖字段的空串/数字串/null 形状——
 * 「留空 = 继承」以 '' 上送，曾因 transform 排在基础校验后整单 400
 * （请求参数无效）；本件锁定 preprocess 归一顺序。
 */
import { describe, expect, it } from 'vitest';
import { modelsContracts } from '../src/http/contracts/models';

describe('modelBindSchema 成本覆盖字段（costPrice 归一）', () => {
  it('空串 → null（继承）；数字串原样保留；缺省 → undefined', () => {
    const parsed = modelsContracts.bind.parse({
      channels: [
        {
          channelId: 2,
          upstreamModel: 'minimax-m3',
          costInputPrice: '',
          costOutputPrice: '',
          costCacheInputPrice: '',
          costCacheWritePrice: '',
          costUnitPrice: '',
        },
        {
          channelId: 3,
          upstreamModel: 'minimax-m3',
          costInputPrice: '0',
          costOutputPrice: '0',
          costCacheInputPrice: '0',
          costCacheWritePrice: '0',
        },
      ],
    });
    const [inherit, free] = parsed.channels;
    expect(inherit?.costInputPrice).toBeNull();
    expect(inherit?.costUnitPrice).toBeNull();
    expect(free?.costInputPrice).toBe('0');
    expect(free?.costOutputPrice).toBe('0');
    expect(free?.costUnitPrice).toBeNull();
  });

  it('免费渠道全 0 + 空白串（trim 后归一 null）混排可解析', () => {
    const parsed = modelsContracts.bind.parse({
      channels: [
        {
          channelId: 5,
          costInputPrice: '0',
          costOutputPrice: '0',
          costCacheInputPrice: '0',
          costCacheWritePrice: '0',
          costUnitPrice: '0',
        },
        { channelId: 6, costInputPrice: '  ', upstreamModel: 'x' },
      ],
    });
    expect(parsed.channels[0]?.costUnitPrice).toBe('0');
    expect(parsed.channels[1]?.costInputPrice).toBeNull();
  });

  it('负数/非数字串仍拒绝（形状校验不被 preprocess 旁路）', () => {
    expect(() =>
      modelsContracts.bind.parse({ channels: [{ channelId: 1, costInputPrice: '-1' }] }),
    ).toThrow();
    expect(() =>
      modelsContracts.bind.parse({ channels: [{ channelId: 1, costInputPrice: 'abc' }] }),
    ).toThrow();
  });
});
