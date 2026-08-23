/**
 * config 契约测试：协议/档案词表快照封闭性（IMPLEMENTATION §6——快照失配
 * 唯一后果是后端 zod 400，但快照本身必须与裁决记录一致且不可漂移）。
 */
import { describe, expect, it } from 'vitest';

import { SUPPORTED_PROTOCOLS, VENDOR_PROFILE_NAMES } from '../src/config/protocols';
import { APP_CONFIG } from '../src/config/app-config';

/** 裁决记录值（2026-08-23，来源 ai 包 defaultAdapters/VENDOR_PROFILES；P6 切换前锁死） */
const PROTOCOLS_SNAPSHOT = [
  'openai-compatible',
  'anthropic',
  'gemini',
  'azure-openai',
  'aws-bedrock',
  'vertex-ai',
  'minimax',
  'dashscope',
] as const;

const VENDORS_SNAPSHOT = [
  'openai',
  'deepseek',
  'moonshot',
  'together',
  'nvidia',
  'xai',
  'zai',
] as const;

describe('protocols 过渡快照（P6 /v1/vendor-catalog 落地前唯一词表）', () => {
  it('协议词表与裁决记录逐项相等（顺序也一致——下拉展示稳定）', () => {
    expect([...SUPPORTED_PROTOCOLS]).toEqual([...PROTOCOLS_SNAPSHOT]);
  });

  it('厂商档案词表与裁决记录逐项相等', () => {
    expect([...VENDOR_PROFILE_NAMES]).toEqual([...VENDORS_SNAPSHOT]);
  });

  it('词表封闭：无重复项', () => {
    expect(new Set(SUPPORTED_PROTOCOLS).size).toBe(SUPPORTED_PROTOCOLS.length);
    expect(new Set(VENDOR_PROFILE_NAMES).size).toBe(VENDOR_PROFILE_NAMES.length);
  });
});

describe('app-config', () => {
  it('应用名/版本元数据形状', () => {
    expect(typeof APP_CONFIG.name).toBe('string');
    expect(APP_CONFIG.name.length).toBeGreaterThan(0);
    expect(APP_CONFIG).toHaveProperty('meta');
  });
});
