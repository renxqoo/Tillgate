import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { channels, modelChannels, modelMappings, providers } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import {
  CATALOG_SOURCES,
  importCatalogModels,
  type CatalogSource,
} from '../../services/model-catalog.js';
import { makeServices } from '../../test/helpers.js';

/**
 * M3 回归锁定：目录导入必须原子。
 * provider/channel 创建 + 逐模型 upsert 不在一个事务时，中途 EXTERNAL_NAME_CONFLICT
 * 抛错会留下半成品（provider + free 渠道 + 部分映射已落库）。
 * 用注册的临时目录源（独立 provider/channel 名）预置冲突模型，断言 409 后无任何残留。
 * 数据纪律：全部 p1api- 前缀，finally 只删自己创建的行（含红测阶段的残留）。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

let connected = false;
beforeAll(async () => {
  try {
    await db.query.providers.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('目录导入原子性（M3）', () => {
  it('导入中途外部名冲突 → 409 且无 provider/channel/映射/绑定残留', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = randomUUID().slice(0, 8);
    const sourceId = `p1api-src-${suffix}`;
    const providerName = `p1api-prov-${suffix}`.slice(0, 32);
    const channelName = `p1api-ch-${suffix}`;
    const conflictExt = `p1api-conflict-${suffix}`.slice(0, 64);
    const newExt = `p1api-new-${suffix}`;
    CATALOG_SOURCES[sourceId] = {
      id: sourceId,
      name: 'p1api 原子性测试源',
      providerName,
      providerBaseUrl: 'http://localhost:9',
      providerProtocol: 'openai-compatible',
      channelName,
      needsKey: true,
      fetchModels: async () => ({}),
      mapModels: () => [],
    } satisfies CatalogSource;
    // 预置占用冲突外部名的既有模型（绑定到另一个真实模型）
    const [conflict] = await db
      .insert(modelMappings)
      .values({
        externalName: conflictExt,
        realModel: `p1api/occupied-${suffix}`,
        status: 0,
        inputPrice: '0',
        outputPrice: '0',
        cacheInputPrice: '0',
      })
      .returning({ id: modelMappings.id });
    const s = makeServices(db);
    try {
      // 第二个模型触发冲突 → 整个导入必须失败
      await expect(
        importCatalogModels(s, {
          sourceId,
          apiKey: 'p1api-test-key',
          models: [
            {
              externalName: newExt,
              realModel: `p1api/fresh-${suffix}`,
              inputPrice: 0,
              outputPrice: 0,
              cacheInputPrice: 0,
            },
            {
              externalName: conflictExt,
              realModel: `p1api/different-${suffix}`,
              inputPrice: 0,
              outputPrice: 0,
              cacheInputPrice: 0,
            },
          ],
        }),
      ).rejects.toMatchObject({ status: 409, code: 'EXTERNAL_NAME_CONFLICT' });

      // 原子性：失败后数据库无半成品残留
      expect(
        await db.query.providers.findFirst({ where: eq(providers.name, providerName) }),
      ).toBeUndefined();
      expect(
        await db.query.channels.findFirst({ where: eq(channels.name, channelName) }),
      ).toBeUndefined();
      expect(
        await db.query.modelMappings.findFirst({ where: eq(modelMappings.externalName, newExt) }),
      ).toBeUndefined();
    } finally {
      delete CATALOG_SOURCES[sourceId];
      // 清理：自己预置的冲突模型 + 红测阶段（修复前）可能的残留行
      const exts = [newExt, conflictExt];
      const rows = await db
        .select()
        .from(modelMappings)
        .where(inArray(modelMappings.externalName, exts));
      for (const m of rows) {
        await db.delete(modelChannels).where(eq(modelChannels.mappingId, m.id));
        await db.delete(modelMappings).where(eq(modelMappings.id, m.id));
      }
      void conflict;
      await db.delete(channels).where(eq(channels.name, channelName));
      await db.delete(providers).where(eq(providers.name, providerName));
    }
  });

  it('无冲突导入仍完整落库（回归：事务包裹不破坏正常路径）', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = randomUUID().slice(0, 8);
    const sourceId = `p1api-src-ok-${suffix}`;
    const providerName = `p1api-prov-ok-${suffix}`.slice(0, 32);
    const channelName = `p1api-ch-ok-${suffix}`;
    const newExt = `p1api-ok-${suffix}`;
    CATALOG_SOURCES[sourceId] = {
      id: sourceId,
      name: 'p1api 原子性测试源',
      providerName,
      providerBaseUrl: 'http://localhost:9',
      providerProtocol: 'openai-compatible',
      channelName,
      needsKey: true,
      fetchModels: async () => ({}),
      mapModels: () => [],
    } satisfies CatalogSource;
    const s = makeServices(db);
    try {
      const result = await importCatalogModels(s, {
        sourceId,
        apiKey: 'p1api-test-key',
        models: [
          {
            externalName: newExt,
            realModel: `p1api/ok-${suffix}`,
            inputPrice: 0,
            outputPrice: 0,
            cacheInputPrice: 0,
          },
        ],
      });
      expect(result.created).toBe(1);
      expect(
        await db.query.providers.findFirst({ where: eq(providers.name, providerName) }),
      ).not.toBeNull();
      expect(
        await db.query.channels.findFirst({ where: eq(channels.name, channelName) }),
      ).not.toBeNull();
    } finally {
      delete CATALOG_SOURCES[sourceId];
      const m = await db.query.modelMappings.findFirst({
        where: eq(modelMappings.externalName, newExt),
      });
      if (m) {
        await db.delete(modelChannels).where(eq(modelChannels.mappingId, m.id));
        await db.delete(modelMappings).where(eq(modelMappings.id, m.id));
      }
      await db.delete(channels).where(eq(channels.name, channelName));
      await db.delete(providers).where(eq(providers.name, providerName));
    }
  });
});
