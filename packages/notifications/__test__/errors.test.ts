/**
 * 错误目录封闭性:码表快照锁死(新增码 = 契约变更)。
 */
import { describe, expect, it } from 'vitest';
import { notificationsErrors } from '../src/errors';
import { defined } from './defined';

describe('notifications 错误目录', () => {
  const KEYS = [
    'invalid_channel_input',
    'channel_exists',
    'channel_not_found',
    'unknown_event',
    'invalid_outbox_input',
  ] as const;

  it('码表快照(命名空间 + 全量码,排序稳定)', () => {
    expect(notificationsErrors.namespace).toBe('notifications');
    expect([...notificationsErrors.codes].toSorted()).toEqual(
      [...KEYS].map((key) => `notifications.${key}`).toSorted(),
    );
  });

  it('entry 双语与 category 齐(message 英文/zh 中文)', () => {
    for (const key of KEYS) {
      const entry = defined(notificationsErrors.entry(key), key);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.message).toMatch(/^[\x20-\x7e]+$/); // 英文 ASCII
      expect(entry.zh.length).toBeGreaterThan(0);
    }
  });

  it('has/get 查询面', () => {
    expect(notificationsErrors.has('notifications.channel_exists')).toBe(true);
    expect(notificationsErrors.has('notifications.nope')).toBe(false);
    expect(notificationsErrors.get('notifications.unknown_event')?.message).toContain('event');
    expect(notificationsErrors.get('other.unknown_event')).toBeUndefined();
  });
});
