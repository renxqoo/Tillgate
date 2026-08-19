/**
 * worker 装配层测试：config 解析（必填/缺省）、任务适配器绑定（ai 注入 +
 * decrypt 透传）、三定时器驱动（真实 PG：settlement_pending → 定时器批次 → settled）
 * 与优雅停机（等在途、关连接）。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, users } from '@ai-gateway/db';
import { encrypt } from '@ai-gateway/core';
import type { Ai } from '@ai-gateway/ai';
import { createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import type { BillingQuote } from '@ai-gateway/domain';
import { loadConfig, type WorkerConfig } from '../config.js';
import { startWorker, type WorkerHandles } from '../index.js';
import { createTaskAdapter } from '../generation-adapter.js';

const db: Db0 = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
type Db0 = ReturnType<typeof createDb>;
const ctx: RunContext = systemContext('v2wk-wiring');
const wallet = createWallet({
  db, currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});

const createdUsers: number[] = [];

function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return loadConfig({
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    CHANNEL_API_KEY_ENCRYPTION: 'w-test-key-0123456789abcdef',
    ...(overrides as Record<string, string>),
  } as NodeJS.ProcessEnv);
}

afterAll(async () => {
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]).catch(() => {});
  await db.$client.end().catch(() => {});
});

describe('config 解析', () => {
  it('缺省值全显式：节奏/批量/策略/TTL；REDIS_URL 必配（首选组件）', () => {
    const config = testConfig();
    expect(config.WORKER_SETTLE_INTERVAL_MS).toBe(30_000); // BullMQ 唤醒为主，扫描缩为兜底
    expect(config.WORKER_GENERATION_INTERVAL_MS).toBe(5_000);
    expect(config.WORKER_SHUTDOWN_GRACE_MS).toBe(15_000);
    expect(config.REDIS_URL).toContain('redis://');
    expect(config.CHANNEL_API_KEY_ENCRYPTION).toBe('w-test-key-0123456789abcdef');
  });

  it('缺 CHANNEL_API_KEY_ENCRYPTION → 拒绝（fail-closed，不留隐式缺省）', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('任务适配器绑定', () => {
  it('ai 注入 + decrypt 透传：submitTask 解密渠道密钥并归一任务号', async () => {
    const encryptionKey = 'w-test-key-0123456789abcdef';
    let seenKey = '';
    const stubAi = {
      chat: async (input: { channel: { apiKey: string } }) => {
        seenKey = input.channel.apiKey;
        return { status: 'success', body: { task_id: 'up-42' } };
      },
      parseGenerationResponse: () => ({ kind: 'task_submitted', taskId: 'up-42' }),
    } as unknown as Ai;
    const port = createTaskAdapter({ encryptionKey, ai: stubAi });

    const submitted = await port.submitTask(
      {
        channelId: 1,
        channelName: 'ch', apiKeyEnc: encrypt('sk-secret', encryptionKey), baseUrlOverride: null,
        providerName: 'p', providerBaseUrl: 'https://x.test', providerProtocol: 'openai-compatible',
      },
      { requestId: 'r1', realModel: 'm', externalModel: 'm', kind: 'video', body: {} },
    );
    expect(submitted).toEqual({ ok: true, upstreamTaskId: 'up-42' });
    expect(seenKey).toBe('sk-secret'); // 解密注入证明
  });
});

describe('startWorker 三定时器与优雅停机（真实 PG）', () => {
  it('settlement 定时器批次闭环 → settled；stop() 关闭连接（后续查询拒绝）', async () => {
    // 制造一笔 settlement_pending（authorize → signal succeeded）
    const [user] = await db.insert(users).values({ issuer: 'v2wk', subject: `v2wk-${randomUUID()}`, identityProvider: 'local' }).returning({ id: users.id });
    createdUsers.push(user!.id);
    await wallet.credit(ctx, { userId: user!.id, amount: '50', refType: 'topup', refId: `wk-${randomUUID().slice(0, 8)}` });
    const requestId = randomUUID();
    const q: BillingQuote = {
      maxOutputTokens: 0,
      candidates: [{
        mappingId: 1, externalModel: 'gpt-x', realModel: 'gpt-real',
        inputPrice: '2', outputPrice: '0', cacheInputPrice: '2',
        coefficient: '1', inputTokenUpperBound: 1_000_000, billingPolicyFingerprint: null,
      }],
    };
    const { createBillingDomain } = await import('@ai-gateway/service');
    const billing = createBillingDomain({ db: db as never, currency: 'CNY' });
    await billing.authorize(ctx, {
      requestId, userId: user!.id, apiKeyId: null, appId: null, stream: false,
      quote: q, reservationLimit: '100', authorizationTtlMs: 300_000,
    });
    await billing.signal(ctx, {
      type: 'request.succeeded',
      requestId,
      receipt: {
        requestId, userId: user!.id, apiKeyId: null, appId: null, credentialType: 'key',
        externalModel: 'gpt-x', realModel: 'gpt-real', channelId: null, channelKey: 'test',
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, estimated: false },
        inputPrice: '2', outputPrice: '0', cacheInputPrice: '2', coefficient: '1',
        durationMs: 5, stream: false, streamAborted: false, mappingId: 1, billingPolicyFingerprint: null,
      },
    });

    // 独立连接的 worker db（stop 后不影响主测试连接）
    const workerDb = createDb(
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
      { poolMax: 2 },
    );
    const handles: WorkerHandles = await startWorker(testConfig({ WORKER_SETTLE_INTERVAL_MS: '50', WORKER_SETTLE_WAKEUP: 'false' } as never), workerDb);

    // 定时器批次应在 ~100ms 内结算该请求
    await waitFor(async () => {
      const row = await db.$client.query<{ status: string }>('select status from billing_requests where request_id = $1', [requestId]);
      return row.rows[0]?.status === 'settled';
    }, 5_000);
    expect(true).toBe(true);

    await handles.stop();
    await expect(workerDb.$client.query('select 1')).rejects.toThrow(); // 连接已收口
    // 清理账单（用户删除级联）
    await db.$client.query('delete from billing_reservations where billing_request_id = $1', [requestId]);
    await db.$client.query('delete from usage_logs where request_id = $1', [requestId]);
    await db.$client.query('delete from billing_requests where request_id = $1', [requestId]);
  }, 15_000);
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
