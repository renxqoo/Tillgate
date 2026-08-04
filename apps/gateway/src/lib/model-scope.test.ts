import { describe, expect, it } from 'vitest';
import { isModelAllowed } from './model-scope.js';

/**
 * JWT scope.models 越权校验（S3）：
 *   - JWT 签发的 scope.models 白名单内的模型才允许调用
 *   - 静态 Key（allowedModels=null）不限
 *   - 空数组视为不限（配置容错）
 *   - 精确匹配（防前缀注入如 "gpt-4o-mini" ≠ "gpt-4o"）
 */
describe('isModelAllowed（JWT scope.models 越权校验）', () => {
  it('allowedModels=null → 允许任意模型（静态 Key 不限）', () => {
    expect(isModelAllowed(null, 'any-model')).toBe(true);
    expect(isModelAllowed(null, 'gpt-4o')).toBe(true);
  });

  it('allowedModels=[] → 允许任意模型（空数组视为不限，配置容错）', () => {
    expect(isModelAllowed([], 'any-model')).toBe(true);
  });

  it('模型在白名单内 → 允许', () => {
    expect(isModelAllowed(['deepseek-chat', 'gpt-4o-mini'], 'deepseek-chat')).toBe(true);
    expect(isModelAllowed(['deepseek-chat', 'gpt-4o-mini'], 'gpt-4o-mini')).toBe(true);
  });

  it('模型不在白名单内 → 拒绝（越权）', () => {
    expect(isModelAllowed(['deepseek-chat'], 'gpt-4o')).toBe(false);
    expect(isModelAllowed(['gpt-4o'], 'deepseek-chat')).toBe(false);
  });

  it('前缀注入防护：gpt-4o-mini ≠ gpt-4o', () => {
    // 只授权了 gpt-4o-mini，不能调 gpt-4o（精确匹配，非前缀）
    expect(isModelAllowed(['gpt-4o-mini'], 'gpt-4o')).toBe(false);
    expect(isModelAllowed(['gpt-4o'], 'gpt-4o-mini')).toBe(false);
  });

  it('大小写敏感', () => {
    expect(isModelAllowed(['DeepSeek-Chat'], 'deepseek-chat')).toBe(false);
  });
});
