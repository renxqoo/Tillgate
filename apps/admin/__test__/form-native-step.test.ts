/**
 * 回归：费率卡系数字段的原生 number 校验必须覆盖 zod 域（§10 每个 bug 一个回归用例）。
 *
 * bug：NumberField 曾配 step="0.05" + min={0.001}，而 <form> 无 noValidate——
 * 浏览器原生 stepMismatch 先于 zod 拦截提交，合法值序列仅 0.001+0.05n（0.051、0.101…），
 * "1"（默认值，文案明示 1 = 原价）、"1.5"、"9.999" 等 schema 合法值全部被挡，且无任何提示来源。
 *
 * 规格：native 域（min + n·step，n≥0）必须 ⊇ schema 域（numeric(6,3)：0.001..9.999，3 位小数）。
 * 浏览器对 step 校验带浮点容差，此处以 |商-最近整数| < 1e-6 等价模拟。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src', 'features', 'billing', 'rate-cards-content.tsx');

/** 浏览器等价的 step 校验：v ≥ min 且 (v-min)/step 距整数 < 1e-6 */
function nativeValid(v: number, min: number, step: number): boolean {
  if (v < min) return false;
  const q = (v - min) / step;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

describe('费率卡系数原生校验回归', () => {
  it('coefficient 的 step/min 让 schema 域内全部值（含 1 = 原价）通过原生校验', () => {
    const src = readFileSync(SRC, 'utf8');
    const block = src.match(/<NumberField[^>]*name="coefficient"[\s\S]*?\/>/)?.[0];
    expect(block, 'rate-cards-content.tsx 中应存在 coefficient NumberField').toBeDefined();

    const step = Number(block!.match(/step="([\d.]+)"/)?.[1]);
    const min = Number(block!.match(/min=\{([\d.]+)\}/)?.[1]);
    expect(Number.isFinite(step) && step > 0, `step 应为正数，实际 ${block}`).toBe(true);
    expect(Number.isFinite(min) && min > 0, `min 应为正数（系数必须 > 0）`).toBe(true);

    // schema 域全量：0.001..9.999 步进 0.001（numeric(6,3)）
    const blocked: string[] = [];
    for (let k = 1; k <= 9999; k++) {
      const v = k / 1000;
      if (!nativeValid(v, min, step)) blocked.push(v.toFixed(3));
    }
    expect(
      blocked,
      `以下 schema 合法系数被原生 step/min 校验拦截（浏览器 stepMismatch，zod 无法接手）：\n${blocked.slice(0, 10).join(', ')}${blocked.length > 10 ? ' …' : ''}`,
    ).toEqual([]);
  });
});
