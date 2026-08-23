/**
 * 领域纯规则：定价一致性 / 资金数值域 / 系数域 / fx 域 / 幂等键与指纹 /
 * 渠道校验与凭证解析 / 供应商词表校验（v1 对应测试组等价迁移）。
 */
import { describe, expect, it } from 'vitest';
import { isFreeByPrice, freePriceConsistent } from '../src/domain/model/model-pricing';
import { validateModelCreate, validateModelPatch, PRICING_UNITS } from '../src/domain/model/model';
import {
  parseNonNegativeAmount,
  parsePositiveAmount,
  parseSignedNonZeroAmount,
} from '../src/domain/money';
import { validateCoefficient, formatCoefficient } from '../src/domain/rate-card/coefficient';
import {
  applyBuffer,
  normalizeRate,
  normalizeBuffer,
  trimNumeric,
} from '../src/domain/fx/fx-rates';
import { assertOperationId, commandFingerprint } from '../src/domain/operation';
import {
  validateChannelCreate,
  validateChannelPatch,
  maskUpstreamKey,
} from '../src/domain/channel/channel';
import { parseVoucherDataUrl } from '../src/domain/channel/voucher';
import {
  assertProtocol,
  assertVendor,
  validateProviderCreate,
  validateProviderPatch,
  type ProviderCapabilities,
} from '../src/domain/provider/provider';
import { controlPlaneErrors } from '../src/errors';
import { isBusinessError } from '@tokenlens/errors';

const CAPABILITIES: ProviderCapabilities = {
  protocols: ['openai-compatible'],
  vendorProfiles: ['openai', 'deepseek'],
};

describe('免费价格一致性（R6）', () => {
  it('全零价 = 免费；显式免费必须全零（含缓存写价与单位价）', () => {
    expect(isFreeByPrice({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })).toBe(true);
    expect(isFreeByPrice({ inputPrice: '0.000', outputPrice: '0', cacheInputPrice: '0' })).toBe(
      true,
    );
    expect(isFreeByPrice({ inputPrice: '1', outputPrice: '0', cacheInputPrice: '0' })).toBe(false);
    expect(
      freePriceConsistent(true, { inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' }),
    ).toBe(true);
    expect(
      freePriceConsistent(true, {
        inputPrice: '0',
        outputPrice: '0',
        cacheInputPrice: '0',
        unitPrice: '0.1',
      }),
    ).toBe(false);
    expect(
      freePriceConsistent(false, { inputPrice: '1', outputPrice: '0', cacheInputPrice: '0' }),
    ).toBe(true);
  });
});

describe('资金数值域（铁三角：指数/超界拒绝，绝不溢出 PG）', () => {
  it.each(['1e999', '1e21', '-1', 'abc', '1.1.1', ''])('非法定价 %s → null', (raw) => {
    expect(parseNonNegativeAmount(raw)).toBeNull();
  });
  it('合法十进制串解析', () => {
    expect(parseNonNegativeAmount('0')!.toString()).toBe('0');
    expect(parseNonNegativeAmount('12.5')!.toString()).toBe('12.5');
    expect(parsePositiveAmount('0')).toBeNull();
    expect(parsePositiveAmount('0.01')!.toString()).toBe('0.01');
    expect(parseSignedNonZeroAmount('-5')!.toString()).toBe('-5');
    expect(parseSignedNonZeroAmount('5')!.toString()).toBe('5');
    expect(parseSignedNonZeroAmount('0')).toBeNull();
  });
});

describe('模型创建校验', () => {
  const base = {
    externalName: 'alias',
    realModel: 'real',
    prices: { inputPrice: '1', outputPrice: '2', cacheInputPrice: '0.5' },
  };

  it('合法输入归一（缺省价 0 / token / billingConfig {}）', () => {
    const v = validateModelCreate(base);
    expect(v.prices.cacheWritePrice).toBe('0');
    expect(v.pricingUnit).toBe('token');
    expect(v.billingConfig).toEqual({});
    expect(v.isFree).toBe(false);
  });

  it('免费冲突（isFree=true + 非零价）→ free_price_conflict', () => {
    expect(() => validateModelCreate({ ...base, isFree: true })).toThrowError(
      expect.objectContaining({ code: 'control_plane.free_price_conflict' }),
    );
  });

  it.each([
    { ...base, prices: { ...base.prices, inputPrice: '1e999' } },
    { ...base, prices: { ...base.prices, inputPrice: '1e21' } },
    { ...base, contextLength: 1e30 as unknown as number },
    { ...base, pricingUnit: 'banana' },
    { ...base, externalName: 'x'.repeat(65) },
    { ...base, billingConfig: { strategy: 'variant', params: { selector: 'size' } } },
    { ...base, billingConfig: { strategy: 'variant', params: { prices: { a: '1' } } } },
    { ...base, billingConfig: { strategy: 'weird' } },
  ])('非法输入 → invalid_model_input 不触库', (input) => {
    expect(() => validateModelCreate(input as never)).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_model_input' }),
    );
  });

  it('合法 variant（selector + 非空 prices）通过；flat 通过', () => {
    expect(() =>
      validateModelCreate({
        ...base,
        billingConfig: {
          strategy: 'variant',
          params: { selector: 'size', prices: { '1024*1024': '0.2' } },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateModelCreate({ ...base, billingConfig: { strategy: 'flat' } }),
    ).not.toThrow();
  });

  it.each([
    // 空窗口表 / 格式非法 / 零长度 / 无价格字段 / 重叠（形状与重叠语义归 billing 单一真相）
    { strategy: 'schedule', params: { windows: [] } },
    {
      strategy: 'schedule',
      params: { windows: [{ start: '8:00', end: '09:00', unitPrice: '1' }] },
    },
    {
      strategy: 'schedule',
      params: { windows: [{ start: '08:00', end: '08:00', unitPrice: '1' }] },
    },
    { strategy: 'schedule', params: { windows: [{ start: '08:00', end: '09:00' }] } },
    {
      strategy: 'schedule',
      params: {
        windows: [
          { start: '00:00', end: '07:00', unitPrice: '1' },
          { start: '06:00', end: '08:00', unitPrice: '2' },
        ],
      },
    },
    // 价格数值域与 label 长度（control-plane 把关面）
    {
      strategy: 'schedule',
      params: { windows: [{ start: '08:00', end: '09:00', unitPrice: '-1' }] },
    },
    {
      strategy: 'schedule',
      params: { windows: [{ start: '08:00', end: '09:00', unitPrice: '1', label: 'x'.repeat(33) }] },
    },
  ])('非法 schedule 窗口 → invalid_model_input', (billingConfig) => {
    expect(() => validateModelCreate({ ...base, billingConfig }) ).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_model_input' }),
    );
  });

  it('合法 schedule（跨午夜窗口 + 字段级覆盖 + label）通过', () => {
    expect(() =>
      validateModelCreate({
        ...base,
        billingConfig: {
          strategy: 'schedule',
          params: {
            windows: [
              {
                label: '谷时段',
                start: '18:00',
                end: '07:00',
                inputPrice: '0.5',
                outputPrice: '1',
              },
            ],
          },
        },
      }),
    ).not.toThrow();
  });

  it('补丁校验：status 域/单位词表/价格域', () => {
    expect(() => validateModelPatch({ status: 2 })).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_model_input' }),
    );
    expect(() => validateModelPatch({ pricingUnit: 'nope' })).toThrow();
    expect(() => validateModelPatch({ prices: { inputPrice: '-1' } })).toThrow();
    expect(() => validateModelPatch({ status: 1, realModel: 'x' })).not.toThrow();
  });

  it('计价单位词表封闭（导出枚举 == DB CHECK 集合）', () => {
    expect([...PRICING_UNITS]).toEqual(['token', 'request', 'image', 'second', 'char']);
  });
});

describe('费率卡系数域', () => {
  it.each([1.5 as unknown as string, '0', '0.000', '1.0001', '10', '-1', 'abc'])(
    '非法系数 %s → invalid_coefficient',
    (coefficient) => {
      expect(() => validateCoefficient(coefficient)).toThrowError(
        expect.objectContaining({ code: 'control_plane.invalid_coefficient' }),
      );
    },
  );
  it('合法系数格式化恒 3 位小数', () => {
    expect(validateCoefficient('1.5')).toBe('1.500');
    expect(validateCoefficient('0.8')).toBe('0.800');
    expect(validateCoefficient('9.999')).toBe('9.999');
    expect(formatCoefficient('2')).toBe('2.000');
  });
});

describe('fx 域规则', () => {
  it('生效汇率 = base ×(1+buffer/100)', () => {
    expect(applyBuffer('7.2', '2')).toBe('7.344');
    expect(applyBuffer('7.2', '0')).toBe('7.2');
  });
  it('汇率域 0.01–1000；点差域 0–50', () => {
    expect(normalizeRate('7.21')).toBe('7.21');
    expect(() => normalizeRate('0')).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_fx_rate' }),
    );
    expect(() => normalizeRate('9999')).toThrow();
    expect(normalizeBuffer('1.5')).toBe('1.5');
    expect(() => normalizeBuffer('60')).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_fx_buffer' }),
    );
  });
  it('尾零规范化（快照形态稳定）', () => {
    expect(trimNumeric('0.500')).toBe('0.5');
    expect(trimNumeric('2.000')).toBe('2');
    expect(trimNumeric('7')).toBe('7');
  });
});

describe('幂等键与命令指纹', () => {
  it('operationId 契约：1-128 字符，字母数字开头，允许 . _ : -', () => {
    expect(() => assertOperationId('abc-1.2:3')).not.toThrow();
    expect(() => assertOperationId('a'.repeat(129))).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_operation_id' }),
    );
    expect(() => assertOperationId('/bad')).toThrow();
    expect(() => assertOperationId('')).toThrow();
  });
  it('等价命令产生相同摘要；键序无关；undefined 丢弃', () => {
    const a = commandFingerprint('kind', { b: 1, a: 'x' });
    const b = commandFingerprint('kind', { a: 'x', b: 1 });
    const c = commandFingerprint('kind', { a: 'x', b: 1, skip: undefined });
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(commandFingerprint('other', { a: 'x', b: 1 })).not.toBe(a);
  });
});

describe('渠道校验与脱敏', () => {
  const base = { providerId: 1, name: 'ch', apiKey: 'sk-test' };
  it('合法创建归一；重命名/限流域校验', () => {
    expect(validateChannelCreate(base).name).toBe('ch');
    expect(() => validateChannelCreate({ ...base, apiKey: '' })).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_channel_input' }),
    );
    expect(() => validateChannelCreate({ ...base, name: 'x'.repeat(65) })).toThrow();
    expect(() => validateChannelCreate({ ...base, weight: -1 })).toThrow();
    expect(() => validateChannelCreate({ ...base, rpmLimit: 0 })).toThrow();
    expect(() => validateChannelPatch({ upstreamThreshold: '-1' })).toThrow();
    expect(() => validateChannelPatch({ status: 5 })).toThrow();
    expect(() => validateChannelPatch({ upstreamThreshold: '5' })).not.toThrow();
    expect(() => validateChannelPatch({ upstreamThreshold: null })).not.toThrow();
  });
  it('密钥预览：首4+****+尾4；短密钥全掩', () => {
    expect(maskUpstreamKey('sk-abcdef0123xyz')).toBe('sk-a****3xyz');
    expect(maskUpstreamKey('short')).toBe('****');
  });
});

describe('凭证 data URL 解析', () => {
  it('白名单 MIME + 大小上限', () => {
    const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
    const parsed = parseVoucherDataUrl(png, 1024);
    expect(parsed.mimeType).toBe('image/png');
    expect(() => parseVoucherDataUrl('data:image/svg+xml;base64,AAAA', 1024)).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_voucher' }),
    );
    expect(() => parseVoucherDataUrl('not-a-data-url', 1024)).toThrow();
    expect(() =>
      parseVoucherDataUrl(`data:image/png;base64,${Buffer.alloc(2048).toString('base64')}`, 1024),
    ).toThrowError(expect.objectContaining({ code: 'control_plane.voucher_too_large' }));
  });
});

describe('供应商词表校验（单一真相 = 注入词表）', () => {
  it('非法协议/档案 → invalid_protocol / invalid_vendor（业务错误，context 带词表）', () => {
    expect(() => assertProtocol(CAPABILITIES, 'openai')).toThrowError(
      expect.objectContaining({ code: 'control_plane.invalid_protocol' }),
    );
    expect(assertProtocol(CAPABILITIES, 'openai-compatible')).toBe('openai-compatible');
    const err = (() => {
      try {
        assertVendor(CAPABILITIES, 'nonexistent-vendor');
      } catch (e) {
        return e;
      }
    })();
    expect(isBusinessError(err)).toBe(true);
    expect((err as { code: string }).code).toBe('control_plane.invalid_vendor');
  });
  it('vendor 空串/null 归一 null（清除档案）', () => {
    expect(assertVendor(CAPABILITIES, '')).toBeNull();
    expect(assertVendor(CAPABILITIES, null)).toBeNull();
    expect(assertVendor(CAPABILITIES, 'openai')).toBe('openai');
  });
  it('创建形状：name 1-32 / baseUrl http(s) / status 域 / 缺省协议注入', () => {
    const v = validateProviderCreate(
      CAPABILITIES,
      { name: 'p', baseUrl: 'https://a.example.com/v1' },
      'openai-compatible',
    );
    expect(v).toMatchObject({ protocol: 'openai-compatible', vendor: null, status: 0 });
    expect(() =>
      validateProviderCreate(
        CAPABILITIES,
        { name: 'x'.repeat(33), baseUrl: 'https://a.example.com' },
        'openai-compatible',
      ),
    ).toThrow();
    expect(() =>
      validateProviderCreate(
        CAPABILITIES,
        { name: 'p', baseUrl: 'not-a-url' },
        'openai-compatible',
      ),
    ).toThrowError(expect.objectContaining({ code: 'control_plane.invalid_provider_input' }));
    expect(() =>
      validateProviderCreate(
        CAPABILITIES,
        { name: 'p', baseUrl: 'ftp://a.example.com' },
        'openai-compatible',
      ),
    ).toThrow();
    expect(() => validateProviderPatch(CAPABILITIES, { status: 3 })).toThrow();
  });
});

describe('错误目录封闭性（词表 == DESIGN §2.3）', () => {
  it('全部码带命名空间；未知 key 构造失败', () => {
    expect(controlPlaneErrors.codes.length).toBeGreaterThan(0);
    for (const code of controlPlaneErrors.codes) {
      expect(code.startsWith('control_plane.')).toBe(true);
    }
    expect(() => controlPlaneErrors.business('no_such_key' as never)).toThrowError(
      /unknown error catalog key/,
    );
  });
});
