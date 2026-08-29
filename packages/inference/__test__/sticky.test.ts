import { describe, expect, it } from 'vitest';
import { createMemoryStickyStore } from '../src/ports/routing';
import { stickyKeyOf } from '../src/routing/sticky';
import type { RequestAuth } from '../src/domain/model/types';

const authOf = (patch: Partial<RequestAuth>): RequestAuth => ({
  userId: 7,
  apiKeyId: null,
  appId: null,
  allowedModels: null,
  ...patch,
});

describe('routing/sticky：路由指纹（凭证维 + 端点/模型 scope + 前缀）', () => {
  it('凭证维优先级：apiKey > app > user（同 body 不同凭证不同键）', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const byKey = stickyKeyOf({ auth: authOf({ apiKeyId: 3 }), body }, 4_096);
    const byApp = stickyKeyOf({ auth: authOf({ appId: 5 }), body }, 4_096);
    const byUser = stickyKeyOf({ auth: authOf({}), body }, 4_096);
    expect(new Set([byKey, byApp, byUser])).toHaveLength(3);
    // 同凭证同 body → 键稳定（哈希确定性）
    expect(stickyKeyOf({ auth: authOf({ apiKeyId: 3 }), body }, 4_096)).toBe(byKey);
  });

  it('前缀截断：多轮 append-only 会话共享同键；不同前缀分键', () => {
    const long = 'x'.repeat(8_192);
    const turn1 = { messages: [{ role: 'user', content: long }] };
    const turn2 = {
      messages: [
        { role: 'user', content: long },
        { role: 'assistant', content: 'answer' },
      ],
    };
    // 第二轮只 append（前缀不变）→ 同键（KV cache 亲和的前提）
    expect(stickyKeyOf({ auth: authOf({ apiKeyId: 1 }), body: turn1 }, 4_096)).toBe(
      stickyKeyOf({ auth: authOf({ apiKeyId: 1 }), body: turn2 }, 4_096),
    );
    expect(stickyKeyOf({ auth: authOf({ apiKeyId: 1 }), body: turn1 }, 4_096)).not.toBe(
      stickyKeyOf(
        { auth: authOf({ apiKeyId: 1 }), body: { messages: [{ role: 'user', content: 'other' }] } },
        4_096,
      ),
    );
  });

  it('endpoint/externalModel 入 scope：无 messages 端点不与 chat 共享键', () => {
    const body = { input: 'embed-me' };
    const embed = stickyKeyOf(
      { auth: authOf({ apiKeyId: 1 }), body, externalModel: 'emb-x', endpoint: 'embeddings' },
      4_096,
    );
    const chat = stickyKeyOf(
      { auth: authOf({ apiKeyId: 1 }), body, externalModel: 'gpt-x', endpoint: 'chat' },
      4_096,
    );
    expect(embed).not.toBe(chat);
    // messages 缺失（embeddings 等）：序列化退化为固定串，不抛异常
    expect(
      typeof stickyKeyOf({ auth: authOf({ apiKeyId: 1 }), body: {}, endpoint: 'embeddings' }, 256),
    ).toBe('string');
  });
});

/** 固定时钟（淘汰类用例不推进时间——只验证容量/LRU，不掺 TTL 维度） */
const fixedNow = (): number => 1_000;

describe('ports/routing：进程内 sticky（单副本/测试形态）', () => {
  it('set/get 往返 + 过期不命中（懒删）', async () => {
    let now = 1_000;
    const store = createMemoryStickyStore(() => now);
    await store.set('k', 3, 500);
    await expect(store.get('k')).resolves.toBe(3);
    now += 501;
    await expect(store.get('k')).resolves.toBe(null);
    now += 1;
    await expect(store.get('k')).resolves.toBe(null); // 幂等（已删）
  });

  it('set 覆写续期（同键重写 TTL 与值）', async () => {
    let now = 1_000;
    const store = createMemoryStickyStore(() => now);
    await store.set('k', 1, 500);
    now += 400;
    await store.set('k', 2, 500); // 续期
    now += 400; // 首次 TTL 已过、续期未过
    await expect(store.get('k')).resolves.toBe(2);
  });

  it('P2 回归：超容量上限淘汰最旧（无界增长防护）', async () => {
    const store = createMemoryStickyStore(fixedNow, 2);
    await store.set('k1', 1, 10_000);
    await store.set('k2', 2, 10_000);
    await store.set('k3', 3, 10_000); // 超上限 → k1（最旧）被淘汰
    await expect(store.get('k1')).resolves.toBe(null);
    await expect(store.get('k2')).resolves.toBe(2);
    await expect(store.get('k3')).resolves.toBe(3);
  });

  it('LRU 语义：命中重排——被访问的旧键不淘汰，淘汰另一条', async () => {
    const store = createMemoryStickyStore(fixedNow, 2);
    await store.set('k1', 1, 10_000);
    await store.set('k2', 2, 10_000);
    await store.get('k1'); // k1 变为最近使用 → k2 成最旧
    await store.set('k3', 3, 10_000);
    await expect(store.get('k2')).resolves.toBe(null);
    await expect(store.get('k1')).resolves.toBe(1);
    await expect(store.get('k3')).resolves.toBe(3);
  });

  it('maxEntries=1 边界：每次 set 只留最新键', async () => {
    const store = createMemoryStickyStore(fixedNow, 1);
    await store.set('k1', 1, 10_000);
    await store.set('k2', 2, 10_000);
    await expect(store.get('k1')).resolves.toBe(null);
    await expect(store.get('k2')).resolves.toBe(2);
  });
});
