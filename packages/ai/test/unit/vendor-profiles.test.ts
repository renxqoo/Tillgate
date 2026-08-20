import { describe, expect, it } from 'vitest';
import {
  VENDOR_PROFILES,
  mergeParamRules,
  resolveVendorProfile,
  vendorProfileNames,
} from '../../src/registry/vendor-profiles.js';

describe('vendor profiles 注册表', () => {
  it('种子档案带依据（basis 非空——防自造规则）', () => {
    for (const [name, profile] of Object.entries(VENDOR_PROFILES)) {
      expect(profile.basis.length, `${name}.basis`).toBeGreaterThan(10);
      expect(Object.keys(profile.params).length, `${name}.params 非空`).toBeGreaterThan(0);
    }
  });

  it('openai 档案：max_tokens → max_completion_tokens（o 系列拒收 max_tokens）', () => {
    expect(VENDOR_PROFILES['openai']?.params).toEqual({
      map: { max_tokens: { to: 'max_completion_tokens' } },
    });
  });

  it('resolve：已知键 → 档案；空/未知 → null（不猜）', () => {
    expect(resolveVendorProfile('openai')).toBe(VENDOR_PROFILES['openai']);
    expect(resolveVendorProfile(undefined)).toBeNull();
    expect(resolveVendorProfile('')).toBeNull();
    expect(resolveVendorProfile('nonexistent')).toBeNull();
  });

  it('vendorProfileNames 与注册表一致（admin 下拉单一真相）', () => {
    expect([...vendorProfileNames()]).toEqual(Object.keys(VENDOR_PROFILES));
  });
});

describe('mergeParamRules（profile 默认 + per-model 覆盖）', () => {
  it('两侧缺省 → 空规则（透传）', () => {
    expect(mergeParamRules(undefined, undefined)).toEqual({});
    expect(mergeParamRules(undefined, { ignore: ['temperature'] })).toEqual({
      ignore: ['temperature'],
    });
    expect(mergeParamRules({ ignore: ['logprobs'] }, undefined)).toEqual({ ignore: ['logprobs'] });
  });

  it('ignore 并集；map/clamp 逐键 model 侧胜出；unknown model 侧优先', () => {
    const merged = mergeParamRules(
      {
        ignore: ['logprobs'],
        map: { max_tokens: { to: 'max_completion_tokens' }, foo: { to: 'bar' } },
        clamp: { top_p: { max: 1 } },
        unknown: 'passthrough',
      },
      {
        ignore: ['temperature'],
        map: { max_tokens: { to: 'model_prefers_this' } },
        clamp: { top_p: { max: 0.9 }, n: { max: 4 } },
        unknown: 'drop',
      },
    );
    expect(merged).toEqual({
      ignore: ['logprobs', 'temperature'],
      map: { max_tokens: { to: 'model_prefers_this' }, foo: { to: 'bar' } },
      clamp: { top_p: { max: 0.9 }, n: { max: 4 } },
      unknown: 'drop',
    });
  });

  it('unknown 仅 profile 侧声明时回落 profile', () => {
    const merged = mergeParamRules({ unknown: 'drop' }, { ignore: ['x'] });
    expect(merged.unknown).toBe('drop');
    const passthrough = mergeParamRules({ unknown: 'drop' }, { unknown: 'passthrough' });
    expect(passthrough.unknown).toBe('passthrough');
  });
});
