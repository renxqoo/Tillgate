import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import {
  mapOpenRouterCatalog,
  compareCatalog,
  importCatalogModels,
  suggestExternalName,
} from '../services/model-catalog.js';
import { modelCatalogRoutes } from './model-catalog.js';
import { makeAdminTestApp, makeServices } from '../test/helpers.js';

/**
 * 模型目录（OpenRouter 免费模型一键入库）：
 *   - 纯函数：free 过滤 / 对外名建议 / 已导入比对与漂移警告
 *   - 导入（真 PG）：建/复用 provider+channel（rpm 预填 20、free- 前缀）、
 *     映射价格必填、重复导入=价格更新确认、外部名冲突 409
 * 数据纪律：外部名前缀 mc-test-；provider/channel 仅在本次创建时清理。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

const RAW = {
  data: [
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Llama 3.3 70B Instruct',
      context_length: 65536,
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    },
    {
      id: 'deepseek/deepseek-chat-v3:free',
      name: 'DeepSeek V3',
      context_length: 163840,
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    },
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      context_length: 128000,
      pricing: { prompt: '0.0000025', completion: '0.00001', request: '0', image: '0' },
    },
  ],
};

describe('目录纯函数', () => {
  it('mapOpenRouterCatalog：只留免费模型，带对外名建议与上下文长度', () => {
    const items = mapOpenRouterCatalog(RAW);
    expect(items).toHaveLength(2);
    const llama = items.find((i) => i.realModel.includes('llama'))!;
    expect(llama.suggestedName).toBe('llama-3.3-70b-instruct');
    expect(llama.contextLength).toBe(65536);
    expect(items.every((i) => !i.realModel.includes('gpt-4o'))).toBe(true);
  });

  it('suggestExternalName：去厂商前缀与 :free 后缀', () => {
    expect(suggestExternalName('a/b/c:free')).toBe('c');
    expect(suggestExternalName('solo-model:free')).toBe('solo-model');
  });

  it('compareCatalog：已导入回填卖价；上游价>0 且卖价=0 → 漂移警告', () => {
    const items = mapOpenRouterCatalog(RAW);
    const compared = compareCatalog(items, [
      {
        externalName: 'mc-test-deepseek',
        realModel: 'deepseek/deepseek-chat-v3:free',
        inputPrice: '0',
        outputPrice: '0',
      },
    ]);
    const ds = compared.find((i) => i.realModel.includes('deepseek'))!;
    expect(ds.imported).toMatchObject({ externalName: 'mc-test-deepseek' });
    expect(ds.priceWarning).toBeFalsy();
    // 上游开始收费（目录价 > 0）而我们仍 0 卖 → 必须标红
    const drifted = compareCatalog(
      [{ ...ds, catalogPromptUsd: '0.000002', catalogCompletionUsd: '0.00001' }],
      [
        {
          externalName: 'mc-test-deepseek',
          realModel: 'deepseek/deepseek-chat-v3:free',
          inputPrice: '0',
          outputPrice: '0',
        },
      ],
    );
    expect(drifted[0]!.priceWarning).toBe(true);
  });
});

describe('目录导入（真 PG）', () => {
  it('首次导入 → 建 provider/channel/rbac 绑定与映射；重复导入 → 复用并更新价格；冲突 409；缺价 400', async () => {
    if (!connected) return it.skip('no DB');
    const s = makeServices(db);
    const existedProviderBefore =
      (await db.query.providers.findFirst({ where: eq(providers.name, 'openrouter') })) != null;
    const app = makeAdminTestApp({ '/model-catalog': modelCatalogRoutes(s) });
    const ext1 = `mc-test-${randomUUID().slice(0, 6)}`;
    const ext2 = `mc-test-${randomUUID().slice(0, 6)}`;
    try {
      // 首次导入
      const res1 = await app.request('/api/admin/model-catalog/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apiKey: 'sk-or-v1-test',
          models: [
            { externalName: ext1, realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 },
            { externalName: ext2, realModel: 'deepseek/deepseek-chat-v3:free', inputPrice: 1, outputPrice: 2, cacheInputPrice: 0 },
          ],
        }),
      });
      if (res1.status !== 200) console.log('DBG_BODY', await res1.text());
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { providerId: number; channelId: number; created: number; updated: number };
      expect(body1.created).toBe(2);
      expect(body1.updated).toBe(0);

      // provider/channel 落库 + 护栏（rpm 预填 20、free- 前缀渠道名、key 已加密）
      const prov = (await db.query.providers.findFirst({ where: eq(providers.name, 'openrouter') }))!;
      expect(prov.baseUrl).toBe('https://openrouter.ai/api');
      const ch = (await db.query.channels.findFirst({ where: eq(channels.name, 'free-openrouter') }))!;
      expect(ch.rpmLimit).toBe(20);
      expect(ch.providerId).toBe(prov.id);
      expect(ch.apiKeyEnc).not.toContain('sk-or-v1-test');

      // 映射 + 绑定
      const m1 = (await db.query.modelMappings.findFirst({ where: eq(modelMappings.externalName, ext1) }))!;
      expect(m1.realModel).toBe('meta-llama/llama-3.3-70b-instruct:free');
      const binds = await db.select().from(modelChannels).where(eq(modelChannels.mappingId, m1.id));
      expect(binds.map((b) => b.channelId)).toContain(ch.id);

      // 重复导入：无 key 复用渠道；ext1 价格更新（价格确认语义）
      const res2 = await app.request('/api/admin/model-catalog/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: [
            { externalName: ext1, realModel: 'meta-llama/llama-3.3-70b-instruct:free', inputPrice: 5, outputPrice: 6, cacheInputPrice: 0 },
          ],
        }),
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as typeof body1;
      expect(body2.updated).toBe(1);
      expect(body2.created).toBe(0);
      expect(body2.providerId).toBe(prov.id);
      expect(body2.channelId).toBe(ch.id);
      const m1b = (await db.query.modelMappings.findFirst({ where: eq(modelMappings.externalName, ext1) }))!;
      expect(m1b.inputPrice).toBe('5.000000000000000000');

      // 外部名被其他真实模型占用 → 409（约束冲突在边界层翻译）
      const res3 = await app.request('/api/admin/model-catalog/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: [
            { externalName: ext1, realModel: 'another/different-model:free', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 },
          ],
        }),
      });
      expect(res3.status).toBe(409);

      // 价格缺失 → 400（zod 边界校验）
      const res4 = await app.request('/api/admin/model-catalog/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          models: [{ externalName: 'mc-test-x', realModel: 'x/y:free', outputPrice: 0 }],
        }),
      });
      expect(res4.status).toBe(400);
    } finally {
      // 只清自己创建的（前缀 + 本次存在的 provider/channel）
      const exts = [ext1, ext2];
      const mappings = await db.select().from(modelMappings).where(inArray(modelMappings.externalName, exts));
      if (mappings.length > 0) {
        await db.delete(modelChannels).where(inArray(modelChannels.mappingId, mappings.map((m) => m.id)));
        await db.delete(modelMappings).where(inArray(modelMappings.id, mappings.map((m) => m.id)));
      }
      if (!existedProviderBefore) {
        await db.delete(channels).where(eq(channels.name, 'free-openrouter'));
        await db.delete(providers).where(eq(providers.name, 'openrouter'));
      }
    }
  });

  it('importCatalogModels 直接调用与路由等价（服务层契约）', async () => {
    if (!connected) return it.skip('no DB');
    const s = makeServices(db);
    const ext = `mc-test-svc-${randomUUID().slice(0, 6)}`;
    let created: { providerId: number; channelId: number } | null = null;
    try {
      const result = await importCatalogModels(s, {
        apiKey: 'sk-or-v1-test',
        models: [
          { externalName: ext, realModel: 'qwen/qwen3-14b:free', inputPrice: 0, outputPrice: 0, cacheInputPrice: 0 },
        ],
      });
      created = { providerId: result.providerId, channelId: result.channelId };
      expect(result.created).toBe(1);
      const m = (await db.query.modelMappings.findFirst({ where: and(eq(modelMappings.externalName, ext)) }))!;
      expect(m.realModel).toBe('qwen/qwen3-14b:free');
    } finally {
      // 服务层直调可能新建 provider/channel——同样清干净（不留带测试 key 的渠道）
      const m = await db.query.modelMappings.findFirst({ where: eq(modelMappings.externalName, ext) });
      if (m) {
        await db.delete(modelChannels).where(eq(modelChannels.mappingId, m.id));
        await db.delete(modelMappings).where(eq(modelMappings.id, m.id));
      }
      if (created) {
        await db.delete(channels).where(eq(channels.id, created.channelId));
        await db.delete(providers).where(eq(providers.id, created.providerId));
      }
    }
  });
});
