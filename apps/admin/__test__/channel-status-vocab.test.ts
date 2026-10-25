import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 渠道状态词表守护（issue #82）：
 * 表单 Select 与列表 STATUS_META 的状态值 → i18n key 映射，必须与 DB 词表
 * （packages/db/src/schema/channels.ts / control-plane domain）一致：
 *   0 启用 / 1 禁用（软退役同值）/ 2 维护 / 3 熔断 / 4 凭据无效。
 * 错位历史：1 曾标「降级」、2 曾标「禁用」——管理员选「禁用」实际写入 2（维护）。
 */
const FORM = join(__dirname, '../src/features/channels/channels-content/channel-form.tsx');
const ROW = join(__dirname, '../src/features/channels/channels-content/channel-row-item.tsx');

/**
 * 词表权威映射（值 → i18n key）；维护词表时同步更新此处与 schema 注释。
 * 两个面各自实际命名空间：表单 0 走 common.enabled，列表 pill 全走 channels 段。
 */
const CANONICAL_FORM: Record<number, string> = {
  0: 'enabled',
  1: 'statusDisabled',
  2: 'statusMaintenance',
  3: 'statusCooldown',
  4: 'statusDead',
};
const CANONICAL_ROW: Record<number, string> = {
  0: 'statusEnabled',
  1: 'statusDisabled',
  2: 'statusMaintenance',
  3: 'statusCooldown',
  4: 'statusDead',
};

function formMappings(): Map<number, string> {
  const src = readFileSync(FORM, 'utf-8');
  const out = new Map<number, string>();
  // items 数组的字面量映射（t/tc 两变体—— 0 启用走 common 词表，其余走 channels）
  for (const m of src.matchAll(/\{ value: '(\d)', label: t[c]?\('([a-zA-Z]\w+)'\) \}/g)) {
    out.set(Number(m[1]), m[2] ?? '');
  }
  return out;
}

/** SelectItem children 形态（Base UI 实际渲染的下拉选项来源）——与 items 清单独立维护，须同步 */
function formSelectItemMappings(): Map<number, string> {
  const src = readFileSync(FORM, 'utf-8');
  const out = new Map<number, string>();
  for (const m of src.matchAll(
    /<SelectItem value="(\d)">\{t[c]?\('([a-zA-Z]\w+)'\)\}<\/SelectItem>/g,
  )) {
    out.set(Number(m[1]), m[2] ?? '');
  }
  return out;
}

function rowMetaLabels(): Map<number, string> {
  const src = readFileSync(ROW, 'utf-8');
  const out = new Map<number, string>();
  for (const m of src.matchAll(/(\d): \{ label: '(\w+)'/g)) {
    out.set(Number(m[1]), m[2] ?? '');
  }
  return out;
}

function messagesOf(locale: 'zh' | 'en'): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(__dirname, `../messages/${locale}.json`), 'utf-8')) as {
      channels: Record<string, string>;
    }
  ).channels;
}

describe('渠道状态词表守护（#82）', () => {
  it('表单 Select 的 值→label 映射 = 词表权威（0-4 全集）', () => {
    expect(Object.fromEntries(formMappings())).toEqual(CANONICAL_FORM);
  });

  it('SelectItem children 清单与 items 清单同步（改一处漏一处时此处必红——pr #85 路 C #4）', () => {
    expect(Object.fromEntries(formSelectItemMappings())).toEqual(
      Object.fromEntries(formMappings()),
    );
  });

  it('列表 STATUS_META 的 值→label 映射 = 词表权威', () => {
    expect(Object.fromEntries(rowMetaLabels())).toEqual(CANONICAL_ROW);
  });

  it('两个映射的 key 在 zh/en 词表都存在（缺 key = NEXT_INTL 运行时崩溃）', () => {
    for (const locale of ['zh', 'en'] as const) {
      const channels = messagesOf(locale);
      const parsed = JSON.parse(
        readFileSync(join(__dirname, `../messages/${locale}.json`), 'utf-8'),
      ) as { common: Record<string, string> };
      const { common } = parsed;
      for (const [value, key] of Object.entries(CANONICAL_ROW)) {
        void value;
        expect(channels[key], `${locale}:${key}`).toBeTruthy();
      }
      expect(common.enabled, `${locale}:common.enabled`).toBeTruthy();
      expect(channels.statusUnknown, `${locale}:statusUnknown`).toBeTruthy();
    }
  });

  it('死键清理：statusDegraded 已删（无消费方，词表不留孤儿）', () => {
    for (const locale of ['zh', 'en'] as const) {
      expect(messagesOf(locale).statusDegraded).toBeUndefined();
    }
  });
});
