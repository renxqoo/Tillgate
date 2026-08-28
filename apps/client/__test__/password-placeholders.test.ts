/**
 * 用户端密码/密钥输入契约：所有以 password 形态遮蔽的输入框都必须
 * 提供由当前命名空间词表驱动的 placeholder，禁止空字符串和硬编码文案。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import zh from '../messages/zh.json';

const featuresRoot = join(import.meta.dirname, '..', 'src', 'features');

function passwordInputTags(): Array<{ file: string; tag: string }> {
  const tags: Array<{ file: string; tag: string }> = [];
  const files = readdirSync(featuresRoot, { recursive: true }).filter(
    (file): file is string => typeof file === 'string' && file.endsWith('.tsx'),
  );
  for (const file of files) {
    const source = readFileSync(join(featuresRoot, file), 'utf8');
    const inputs = source.match(/<(?:Input|InputGroupInput|PasswordInput)\b[\s\S]*?\/>/g) ?? [];
    for (const tag of inputs) {
      const isPasswordInput =
        tag.startsWith('<PasswordInput') ||
        /type\s*=\s*(?:"password"|\{[^}]*['"]password['"][^}]*\})/.test(tag);
      if (isPasswordInput) tags.push({ file, tag });
    }
  }
  return tags;
}

function message(messages: Record<string, unknown>, namespace: string, key: string): unknown {
  const group = messages[namespace];
  return typeof group === 'object' && group !== null
    ? (group as Record<string, unknown>)[key]
    : undefined;
}

describe('用户端密码输入 placeholder', () => {
  it('全部 password 形态输入框都通过 i18n 提供非空 placeholder', () => {
    const inputs = passwordInputTags();
    expect(inputs.length, '守护面缩小：password 形态输入框少于现状 9 个').toBeGreaterThanOrEqual(9);
    for (const { file, tag } of inputs) {
      expect(tag, `${file} 缺少 i18n placeholder`).toMatch(
        /placeholder\s*=\s*\{[\s\S]*\bt(?:Common)?\(/,
      );
    }
  });

  it('所有密码 placeholder 键在中英词表中均存在且非空', () => {
    const keys = [
      ['auth', 'passwordPlaceholder'],
      ['auth', 'passwordMinPlaceholder'],
      ['auth', 'newPasswordPlaceholder'],
      ['auth', 'confirmPasswordPlaceholder'],
      ['settings', 'oldPasswordPlaceholder'],
      ['settings', 'newPasswordPlaceholder'],
      ['settings', 'confirmPasswordPlaceholder'],
      ['playground', 'keyPlaceholder'],
    ] as const;
    for (const [namespace, key] of keys) {
      for (const messages of [en, zh]) {
        expect(message(messages, namespace, key), `${namespace}.${key} 缺译文`).toEqual(
          expect.any(String),
        );
        expect(message(messages, namespace, key)).not.toBe('');
      }
    }
  });
});
