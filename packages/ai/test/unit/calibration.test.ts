import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKEN_ESTIMATE_CALIBRATION,
  resolveCalibration,
} from '../../src/usage/calibration.js';

describe('DEFAULT_TOKEN_ESTIMATE_CALIBRATION（固定配置，唯一配置来源）', () => {
  it('defaults + tokensPerByte 初始值来自实测', () => {
    expect(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.defaults).toEqual({
      cjk: 0.7,
      word: 1.1,
      number: 1.0,
      symbol: 1.0,
    });
    expect(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.tokensPerByte).toBe(0.12);
  });

  it('models 含 MiniMax-M3 实测 tokensPerByte（0.03），providers 空骨架', () => {
    expect(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.providers).toEqual({});
    expect(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.models['minimax:MiniMax-M3']).toEqual({
      tokensPerByte: 0.03,
    });
  });
});

describe('resolveCalibration（固定配置解析：defaults ← provider ← provider:model）', () => {
  it('无 provider/model 命中 → defaults + 0 偏移 + 全局 tokensPerByte', () => {
    const r = resolveCalibration();
    expect(r.weights).toEqual({ cjk: 0.7, word: 1.1, number: 1.0, symbol: 1.0 });
    expect(r.templateInputOffset).toBe(0);
    expect(r.tokensPerByte).toBe(0.12);
  });

  it('model 级覆盖生效（MiniMax-M3 → tokensPerByte 0.03）', () => {
    const r = resolveCalibration('minimax', 'MiniMax-M3');
    expect(r.tokensPerByte).toBe(0.03);
    expect(r.weights).toEqual(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.defaults);
  });

  it('未命中的 provider/model 回退 defaults 与全局 tokensPerByte', () => {
    const r = resolveCalibration('unknown', 'unknown-model');
    expect(r.weights).toEqual(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.defaults);
    expect(r.templateInputOffset).toBe(0);
    expect(r.tokensPerByte).toBe(0.12);
  });
});
