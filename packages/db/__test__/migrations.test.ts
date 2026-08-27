/**
 * 迁移链结构一致性。
 *
 * 迁移 SQL 是已应用于生产的物理事实,一字不改;本测试锁的是「链本身」的结构不变量:
 * journal 与 SQL 文件 1:1、编号单调递增、历史缺口显式断言。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defined } from './defined.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

const journal: { entries: JournalEntry[] } = JSON.parse(
  readFileSync(`${migrationsDir}/meta/_journal.json`, 'utf8'),
);

const journalTags = journal.entries.map((e) => e.tag);
const sqlFiles = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .map((f) => f.slice(0, -4)); // 去掉 .sql → 与 tag 同形

const tagNumber = (tag: string) => Number(tag.slice(0, 4));

describe('migration journal ↔ SQL files', () => {
  it('journal 每个条目都有对应 SQL 文件', () => {
    const missing = journalTags.filter((tag) => !existsSync(`${migrationsDir}/${tag}.sql`));
    expect(missing).toEqual([]);
  });

  it('没有游离于 journal 之外的 SQL 文件', () => {
    expect(sqlFiles.toSorted()).toEqual(journalTags.toSorted());
  });

  it('条目总数 = 93(0000-0093,历史缺口 0036 在案;0076 = identity 七表;0081 = admins.role;0082 = 动态 RBAC 权限树/角色;0083 = drop admins.role 旧列;0084 = 接口绑定;0085 = 接口绑定独立成页;0086 = 第三方集成动态配置;0087 = 集成写权限拆分;0088 = oauth.base 退回 env;0089 = 凭据旧列退役 drop users/admins.password_hash;0090 = 会话失效线旧列退役 drop users/admins.session_invalid_before;0091 = drop admins.two_factor_secret 预留列;0092 = SMTP 探针端点绑定;0093 = 管理员邀请重发端点绑定)', () => {
    expect(journalTags.length).toBe(93);
    expect(journalTags[0]).toBe('0000_rapid_living_mummy');
    expect(journalTags.at(-1)).toBe('0093_admin_resend_invite_endpoint');
  });

  it('tag 编号严格递增,无重复', () => {
    const nums = journalTags.map(tagNumber);
    for (let i = 1; i < nums.length; i += 1) {
      expect(defined(nums[i], 'nums[i]')).toBeGreaterThan(defined(nums[i - 1], 'nums[i - 1]'));
    }
  });

  it('idx 严格递增(允许历史跳跃,不允许回退/重复)', () => {
    for (let i = 1; i < journal.entries.length; i += 1) {
      const cur = defined(journal.entries[i], 'journal.entries[i]');
      const prev = defined(journal.entries[i - 1], 'journal.entries[i - 1]');
      expect(cur.idx).toBeGreaterThan(prev.idx);
    }
  });

  it('历史缺口是断言在案的物理事实:tag 缺 0036、idx 跳 37', () => {
    // 缺口来自早期一次被移除的迁移(生产 journal 即如此);出现新的缺口/回填缺口
    // 都必须先改本断言再改链——防止静默漂移。
    expect(journalTags.some((t) => tagNumber(t) === 36)).toBe(false);
    expect(journal.entries.some((e) => e.idx === 37)).toBe(false);
    expect(journal.entries.map((e) => e.idx)).toEqual(
      expect.arrayContaining([36, 38]), // 0037 占 idx 36,0038 占 idx 38
    );
  });
});
