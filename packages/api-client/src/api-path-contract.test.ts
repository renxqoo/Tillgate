/** v1 路径退役回归：调用封装不再静默翻译旧路径。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('API 路径只有 /v1 一种正式形态', () => {
  it('调用封装中不存在旧路径映射器', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('function mapPath');
    expect(source).toContain("path.startsWith('/v1/')");
  });
});
