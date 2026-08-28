/**
 * postgres 适配器真实 PG 行为等价测试（默认门禁按文件名排除，test:real 显式运行）。
 * 覆盖 SQL 专属语义：唯一索引 23505 翻译、守卫原子 UPDATE、jsonb containment 溯源、
 * 幂等占位冲突、审计 best-effort 写入、凭证 bytea 往返。
 * 环境：DATABASE_URL（根 .env）；不可达时全组跳过（退出码 0——由显式运行者保证环境）。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { defined } from './defined';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { createDb, isUniqueViolation, closeDb, roles, type Db } from '@tillgate/db';
import {
  providers,
  channels,
  modelMappings,
  modelChannels,
  rateCardCoefficients,
  fxRates,
  systemConfigs,
  auditLogs,
  channelRecharges,
  admins,
} from '@tillgate/db';
import { postgresProviderStore } from '../src/adapters/postgres/provider-store';
import { postgresChannelStore } from '../src/adapters/postgres/channel-store';
import { postgresModelStore } from '../src/adapters/postgres/model-store';
import { postgresRateCardStore } from '../src/adapters/postgres/rate-card-store';
import { postgresFxStore, CATALOG_FX_CONFIG_KEY } from '../src/adapters/postgres/fx-store';
import { postgresOperationsStore } from '../src/adapters/postgres/operations-store';
import { createPostgresAuditSink, postgresAuditStore } from '../src/adapters/postgres/audit';
import { createPostgresVoucherStorage } from '../src/adapters/postgres/voucher-storage';
import { postgresAdminStore } from '../src/adapters/postgres/admin-store';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tillgate';
let db: Db | null = null;
const uid = () => `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** 真管理员行（FK：channel_recharges/audit_logs 的 admin_id 引用 admins） */
async function realAdminId(): Promise<number> {
  const [superRole] = await defined(db)
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, 'super_admin'));
  const [row] = await defined(db)
    .insert(admins)
    .values({
      email: `${uid()}@example.com`,
      roleId: defined(superRole).id,
    })
    .returning({ id: admins.id });
  return defined(row).id;
}

/** viewer 角色 id（0082 种子保证存在;用例建行挂 viewer） */
async function viewerRoleId(): Promise<number> {
  const [role] = await defined(db)
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, 'viewer'));
  if (role == null) throw new Error('viewer role missing (run migrations 0082)');
  return role.id;
}

beforeAll(async () => {
  try {
    const candidate = createDb({
      url,
      poolMax: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    });
    await candidate
      .select({ one: sql<number>`1` })
      .from(providers)
      .limit(1);
    db = candidate;
  } catch {
    db = null;
  }
});
afterAll(async () => {
  if (db) await closeDb(db);
});

describe('provider-store（真实 PG）', () => {
  it('CRUD + 重名 23505 + 软退役 + 列表 q/排序', async () => {
    if (!db) return;
    const name = uid();
    const row = await postgresProviderStore.insert(db, {
      name,
      protocol: 'openai-compatible',
      vendor: null,
      baseUrl: 'https://a.example.com/v1',
      status: 0,
    });
    expect(await postgresProviderStore.findByName(db, name)).toMatchObject({ id: row.id });
    await expect(
      postgresProviderStore.insert(db, {
        name,
        protocol: 'openai-compatible',
        vendor: null,
        baseUrl: 'https://b.example.com/v1',
        status: 0,
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    const updated = await postgresProviderStore.update(db, {
      providerId: row.id,
      patch: { vendor: 'openai' },
    });
    expect(updated?.vendor).toBe('openai');
    expect(await postgresProviderStore.retire(db, { providerId: row.id })).toBe(true);
    expect(await postgresProviderStore.retire(db, { providerId: row.id })).toBe(true); // 幂等软退役
    const listed = await postgresProviderStore.list(db, {
      q: name,
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(listed.total).toBe(1);
    await db.delete(providers).where(eq(providers.id, row.id));
  });
});

describe('channel-store（真实 PG：守卫原子 UPDATE + 流水）', () => {
  it('进货复活熔断 / 调账非负守卫 / 探针读 join / 流水列表', async () => {
    if (!db) return;
    const provider = await postgresProviderStore.insert(db, {
      name: uid(),
      protocol: 'openai-compatible',
      vendor: null,
      baseUrl: 'https://c.example.com/v1',
      status: 0,
    });
    const adminId = await realAdminId();
    const channel = await postgresChannelStore.insertChannel(db, {
      providerId: provider.id,
      name: uid(),
      apiKeyEnc: 'enc:v1:test',
    });
    // 造熔断态：进货复活
    await db.update(channels).set({ status: 3 }).where(eq(channels.id, channel.id));
    const balance = await postgresChannelStore.rechargeBudget(db, {
      channelId: channel.id,
      amount: '100',
      now: new Date(),
    });
    expect(Number(balance)).toBe(100);
    const afterRecharge = await postgresChannelStore.findChannelFunds(db, channel.id);
    expect(defined(afterRecharge).status).toBe(0); // 3 → 0 复活
    // 调账守卫：-50 成功 / -9999 拒绝
    const ok = await postgresChannelStore.tryAdjustBudget(db, {
      channelId: channel.id,
      amount: '-50',
      now: new Date(),
    });
    expect(ok).toMatchObject({ ok: true, budget: '50.000000000000000000' });
    const blocked = await postgresChannelStore.tryAdjustBudget(db, {
      channelId: channel.id,
      amount: '-9999',
      now: new Date(),
    });
    expect(blocked).toEqual({ ok: false });
    const rechargeId = await postgresChannelStore.insertRecharge(db, {
      channelId: channel.id,
      type: 'recharge',
      amount: '100',
      balanceAfter: balance,
      adminId,
      remark: 'real-test',
    });
    const listed = await postgresChannelStore.listRecharges(db, {
      q: 'real-test',
      sortBy: 'id',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(listed.rows.some((r) => r.id === rechargeId)).toBe(true);
    const probeRow = await postgresChannelStore.findChannelForProbe(db, channel.id);
    expect(probeRow).toMatchObject({
      providerProtocol: 'openai-compatible',
      apiKeyEnc: 'enc:v1:test',
    });
    await db.delete(channelRecharges).where(eq(channelRecharges.id, rechargeId));
    await db.delete(channels).where(eq(channels.id, channel.id));
    await db.delete(providers).where(eq(providers.id, provider.id));
    await db.delete(admins).where(eq(admins.id, adminId));
  });
});

describe('model-store（真实 PG：绑定全量替换 + 幂等绑定）', () => {
  it('CRUD + replaceModelChannels + ensureModelChannelBinding', async () => {
    if (!db) return;
    const inserted = await postgresModelStore.insertMapping(db, {
      externalName: uid(),
      realModel: uid(),
      inputPrice: '1',
      outputPrice: '2',
      cacheInputPrice: '0.5',
      isFree: false,
    });
    expect(inserted.billingConfig).toEqual({});
    const bound = await postgresModelStore.replaceModelChannels(db, {
      mappingId: inserted.id,
      channels: [
        { channelId: 1, weight: 2, priority: 0 },
        { channelId: 2, weight: 1, priority: 5 },
      ],
    });
    expect(bound).toBe(2);
    // 幂等绑定：已存在不重复、不报错
    await postgresModelStore.ensureModelChannelBinding(db, {
      mappingId: inserted.id,
      channelId: 1,
    });
    const ids = await postgresModelStore.listChannelIdsByMappingIds(db, [inserted.id]);
    expect(ids).toHaveLength(2);
    const emptied = await postgresModelStore.replaceModelChannels(db, {
      mappingId: inserted.id,
      channels: [],
    });
    expect(emptied).toBe(0);
    expect(await postgresModelStore.listChannelIdsByMappingIds(db, [inserted.id])).toEqual([]);
    await expect(
      postgresModelStore.insertMapping(db, {
        externalName: inserted.externalName,
        realModel: 'other',
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0',
        isFree: false,
      }),
    ).rejects.toSatisfy(isUniqueViolation);
    await db.delete(modelChannels).where(eq(modelChannels.mappingId, inserted.id));
    await db.delete(modelMappings).where(eq(modelMappings.id, inserted.id));
  });
});

describe('rate-card-store（真实 PG：M1 隔离 + 硬删级联）', () => {
  it('建卡同拍全局行 / PATCH 只碰 global / 删除清系数', async () => {
    if (!db) return;
    const card = await postgresRateCardStore.insertWithGlobal(db, {
      name: uid(),
      description: null,
      coefficient: '1.500',
    });
    await db.insert(rateCardCoefficients).values({
      rateCardId: card.id,
      scope: 'model',
      modelMappingId: 1,
      coefficient: '2.500',
    });
    await postgresRateCardStore.updateWithGlobal(db, {
      rateCardId: card.id,
      patch: {},
      globalCoefficient: '0.800',
    });
    const rows = await db
      .select()
      .from(rateCardCoefficients)
      .where(eq(rateCardCoefficients.rateCardId, card.id));
    expect(defined(rows.find((r) => r.scope === 'global')).coefficient).toBe('0.800');
    expect(defined(rows.find((r) => r.scope === 'model')).coefficient).toBe('2.500'); // 模型行未被全局 PATCH 抹平
    expect(await postgresRateCardStore.findGlobalCoefficient(db, card.id)).toBe('0.800');
    expect(await postgresRateCardStore.deleteCard(db, { rateCardId: card.id })).toBe(true);
    expect(
      await db
        .select()
        .from(rateCardCoefficients)
        .where(eq(rateCardCoefficients.rateCardId, card.id)),
    ).toEqual([]);
  });
});

describe('fx-store（真实 PG：追加表真相 + upsert 配置）', () => {
  it('current 回落最近 auto 行 / override 优先 / config upsert', async () => {
    if (!db) return;
    const auto = await postgresFxStore.insertRate(db, {
      rate: '7.21',
      source: 'ecb',
      mode: 'auto',
    });
    const current = await postgresFxStore.current(db);
    expect(current).toMatchObject({ fxRateId: auto.id, rate: '7.21', source: 'ecb' });
    const manual = await postgresFxStore.insertRate(db, {
      rate: '7.5',
      source: 'manual',
      mode: 'override',
    });
    await postgresFxStore.upsertConfig(db, {
      value: { mode: 'override', overrideRate: '7.5' },
      adminId: 1,
    });
    expect(await postgresFxStore.current(db)).toMatchObject({
      fxRateId: manual.id,
      source: 'manual',
    });
    expect(await postgresFxStore.readConfig(db)).toMatchObject({ mode: 'override' });
    await postgresFxStore.upsertConfig(db, { value: { mode: 'auto' }, adminId: null });
    expect(await postgresFxStore.readConfig(db)).toMatchObject({ mode: 'auto' });
    await db.delete(fxRates).where(inArray(fxRates.id, [auto.id, manual.id]));
    await db.delete(systemConfigs).where(eq(systemConfigs.key, CATALOG_FX_CONFIG_KEY));
  });
});

describe('operations-store（真实 PG：唯一键占位与回执）', () => {
  it('占位 → 回执存档 → 同键占位 null → 重放读回', async () => {
    if (!db) return;
    const operationId = uid();
    const placeholder = await db.transaction(async (tx) => {
      const id = await postgresOperationsStore.insertPlaceholder(tx, {
        operationId,
        kind: 'channel.recharge',
        fingerprint: 'f1',
      });
      if (id != null) {
        await postgresOperationsStore.saveReceipt(tx, id, { rechargeId: 1, balanceAfter: '5' });
      }
      return id;
    });
    expect(placeholder).not.toBeNull();
    const found = await db.transaction((tx) =>
      postgresOperationsStore.findByOperationId(tx, operationId),
    );
    expect(found).toMatchObject({
      fingerprint: 'f1',
      receipt: { rechargeId: 1, balanceAfter: '5' },
    });
    const second = await db.transaction((tx) =>
      postgresOperationsStore.insertPlaceholder(tx, {
        operationId,
        kind: 'channel.recharge',
        fingerprint: 'f1',
      }),
    );
    expect(second).toBeNull();
  });
});

describe('audit（真实 PG：best-effort 写入 + jsonb containment 溯源）', () => {
  it('sink 写入行；价格溯源按 detail.models containment 过滤', async () => {
    if (!db) return;
    const sink = createPostgresAuditSink(db);
    const adminId = await realAdminId();
    const externalName = uid();
    await sink.record({
      actor: 'admin',
      adminId,
      action: 'model_catalog.import',
      targetType: 'provider',
      targetId: '1',
      detail: {
        fx: { baseRate: '7.2' },
        models: [
          { externalName, catalogPrompt: '2.5', submittedInputCny: '18', submittedOutputCny: '72' },
        ],
      },
    });
    const history = await postgresAuditStore.listCatalogPriceHistory(db, { externalName });
    expect(
      history.some(
        (h) =>
          (h.detail as { models?: Array<{ externalName: string }> }).models?.[0]?.externalName ===
          externalName,
      ),
    ).toBe(true);
    await db.delete(auditLogs).where(like(auditLogs.action, 'model_catalog.import'));
    await db.delete(admins).where(eq(admins.id, adminId));
  });
});

describe('voucher-storage（真实 PG：bytea 往返 + 键白名单）', () => {
  it('save → load 字节与 MIME 一致；非法键 null', async () => {
    if (!db) return;
    const storage = createPostgresVoucherStorage(db);
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    const key = await storage.save(bytes, 'image/png');
    expect(key).toMatch(/\.png$/);
    const loaded = await storage.load(key);
    expect(loaded).toMatchObject({ mimeType: 'image/png' });
    expect(Array.from(defined(loaded).data)).toEqual([1, 2, 3, 4, 5]);
    expect(await storage.load('../etc/passwd')).toBeNull();
    const pool = (
      db as unknown as { $client: { query: (q: string, v?: unknown[]) => Promise<unknown> } }
    ).$client;
    await pool.query(`delete from voucher_blobs where "key" = $1`, [key]).catch(() => {});
  });
});

describe('admin-store（真实 PG：RBAC 资料面——role 投影/建行唯一兜底/部分更新/补偿删除）', () => {
  it('create → list → update → remove 全链 + 重名 23505 + id ≥1e9 段分配', async () => {
    if (!db) return;
    const email = `${uid()}@example.com`;
    const roleId = await viewerRoleId();
    // create 需事务形态（id 段分配与插入原子——application 层同款包装）
    const created = await db.transaction((tx) =>
      postgresAdminStore.create(tx, { email, displayName: 'E2E', roleId }),
    );
    expect(created.role).toBe('viewer');
    expect(created.status).toBe(0);
    expect(created.id).toBeGreaterThanOrEqual(1_000_000_000);
    try {
      // 唯一索引兜底（23505 由 application 翻译——此处验原始形状）
      const dup = await db
        .transaction((tx) => postgresAdminStore.create(tx, { email, displayName: null, roleId }))
        .catch((error: unknown) => error);
      expect(isUniqueViolation(dup)).toBe(true);

      // q 搜索（dev 库管理员行可能 ≥100,asc+limit100 未必覆盖新行——用唯一 email 定位,
      // 顺带真库验证 ilike 路径）;total 计数同条件
      const listed = await postgresAdminStore.list(db, {
        q: email,
        sortBy: 'id',
        order: 'asc',
        limit: 100,
        offset: 0,
      });
      expect(listed.rows).toHaveLength(1);
      expect(listed.rows[0]).toMatchObject({ id: created.id });
      expect(listed.rows[0]?.role).toBe('viewer');
      expect(listed.total).toBe(1);

      const updated = await postgresAdminStore.update(db, {
        adminId: created.id,
        status: 1,
      });
      expect(updated).toMatchObject({ status: 1 });
      expect(updated?.role).toBe('viewer');
      expect(await postgresAdminStore.update(db, { adminId: 999_999_999 })).toBeNull();

      const byId = await postgresAdminStore.findById(db, created.id);
      expect(byId?.role).toBe('viewer');
    } finally {
      await postgresAdminStore.remove(db, created.id);
    }
    expect(await postgresAdminStore.findById(db, created.id)).toBeNull();
  });
});
