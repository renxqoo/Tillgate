/**
 * 目录一键入库（channel：find-or-create provider/channel + 绑定 + 上架；
 * reference：草稿 status=1 + 按模型 provider 前缀 find-or-create 对应渠道并绑定——
 * 不再裸落无渠道映射，避免路由时按 realModel 静默「蹭」现有第一个渠道；
 * 重复 skip 改价）。整个导入单事务：中途任何失败（如外部名冲突）整体回滚，不留半成品。
 * provenance（目录原价/fx 行/预填值/提交值）全量进审计——服务端重算预填
 * （与 comparison 同一换算点）。
 */
import type { Db } from '@tillgate/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { SecretCipher } from '../../ports/secret-cipher';
import type { ProviderStore } from '../../ports/provider-store';
import type { ChannelStore } from '../../ports/channel-store';
import type { ModelStore } from '../../ports/model-store';
import { toCny } from '../../domain/catalog/convert';
import { isFreeByPrice } from '../../domain/model/model-pricing';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';
import type { FxDeps } from '../fx/fx-shared';
import { fxState } from '../fx/fx-state';
import { fetchSourceModels, getSource, type SourceCacheDeps } from './fetch-source-models';

export interface ImportCatalogDeps extends SourceCacheDeps {
  readonly db: Db;
  readonly stores: {
    readonly provider: ProviderStore;
    readonly channel: ChannelStore;
    readonly model: ModelStore;
  };
  readonly cipher: SecretCipher;
  /** 渠道限流预填（免费与付费同守——保守默认） */
  readonly channelRpm: number;
  /** 渠道进货额度预填 */
  readonly channelBudget: string;
  readonly fx: FxDeps;
  readonly audit: AuditSink;
}

export interface CatalogImportModelInput {
  readonly externalName: string;
  readonly realModel: string;
  /** 价格必填（CNY 元/百万 token；提交即确认——预填换算值可改） */
  readonly inputPrice: string;
  readonly outputPrice: string;
  readonly cacheInputPrice: string;
  readonly cacheWritePrice: string;
  /** 上下文窗口（token）；目录带入，可空 */
  readonly contextLength?: number | null;
}

export interface ImportCatalogInput {
  readonly ctx: ControlContext;
  readonly sourceId: string;
  /** 首次建渠道需要的平台 API key（复用渠道不覆盖已存 key） */
  readonly apiKey?: string;
  readonly models: CatalogImportModelInput[];
}

export interface ImportCatalogResult {
  readonly providerId: number | null;
  readonly channelId: number | null;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}

/**
 * reference 源骨架渠道的非路由占位基址：RFC 6761 保留 .invalid 域——
 * 永不可达，骨架渠道在管理员补全真实基址前只会熔断，不会误打到真实上游。
 */
const PLACEHOLDER_BASE_URL = 'https://placeholder.invalid';
/** 骨架渠道占位密钥（同 channel 源 no-key 语义；管理员换真实 Key 后恢复） */
const PLACEHOLDER_API_KEY = 'no-key-required';
/** providers.name 与 channels.name 的公共长度上限（取两者较小值，slug 同长度查建） */
const SLUG_MAX = 32;

/**
 * 模型真实名 → 对应渠道 slug：reference 源 realModel 形如 `provider/id`
 * （models.dev 口径），取首段 `/` 前缀；无前缀整体作 slug。
 */
function providerSlugOf(realModel: string): string {
  const slash = realModel.indexOf('/');
  return (slash > 0 ? realModel.slice(0, slash) : realModel).slice(0, SLUG_MAX);
}

export async function importCatalog(
  deps: ImportCatalogDeps,
  input: ImportCatalogInput,
): Promise<ImportCatalogResult> {
  if (input.models.length === 0) {
    throw controlPlaneErrors.business('catalog_empty');
  }
  const source = getSource(deps, input.sourceId);

  // provenance：服务端重算预填（与 comparison 同一换算点）
  const { fetchedAt, raw } = await fetchSourceModels(deps, source);
  const items = source.mapModels(raw);
  const fxStateNow = await fxState(deps.fx);
  const byReal = new Map(items.map((i) => [i.realModel, i]));
  const prefillOf = (price: string): string | null =>
    toCny(price, source.priceCurrency, fxStateNow.effectiveRate);

  const result = await deps.db.transaction(async (tx) => {
    let providerId: number | null = null;
    let channelId: number | null = null;

    if (source.channel) {
      // 渠道型：provider find-or-create（目录源即供应商）
      let provider = await deps.stores.provider.findByName(tx, source.channel.providerName);
      if (!provider) {
        provider = await deps.stores.provider.insert(tx, {
          name: source.channel.providerName,
          protocol: source.channel.providerProtocol,
          vendor: null,
          baseUrl: source.channel.providerBaseUrl,
          status: 0,
        });
      }
      providerId = provider.id;

      // 渠道 find-or-create（首次需要平台 key；复用不覆盖已存 key）
      const existingChannel = await deps.stores.channel.findChannelByName(
        tx,
        source.channel.channelName,
      );
      if (existingChannel) {
        channelId = existingChannel.id;
      } else {
        if (!input.apiKey && source.channel.needsKey) {
          throw controlPlaneErrors.business('catalog_api_key_required', { source: source.name });
        }
        const created = await deps.stores.channel.insertChannel(tx, {
          providerId: provider.id,
          name: source.channel.channelName,
          apiKeyEnc: deps.cipher.encrypt(input.apiKey ?? 'no-key-required'),
          rpmLimit: deps.channelRpm,
          upstreamBudget: deps.channelBudget,
        });
        channelId = created.id;
      }
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // reference 源：按模型 provider 前缀对应渠道 find-or-create 的导入内记忆
    // （同批同 provider 只查/建一次；回滚随事务一起作废）
    const refChannelIds = new Map<string, number>();
    const ensureReferenceChannel = async (realModel: string): Promise<number> => {
      const slug = providerSlugOf(realModel);
      const memo = refChannelIds.get(slug);
      if (memo != null) return memo;
      // 存在对应渠道 → 直接复用（不创建、不覆盖 Key/基址——管理员已配好的真实渠道优先）
      const existing = await deps.stores.channel.findChannelByName(tx, slug);
      if (existing) {
        refChannelIds.set(slug, existing.id);
        return existing.id;
      }
      // 不存在 → provider find-or-create 后建骨架渠道（占位基址/Key，管理员后补）
      let provider = await deps.stores.provider.findByName(tx, slug);
      if (!provider) {
        provider = await deps.stores.provider.insert(tx, {
          name: slug,
          protocol: 'openai-compatible',
          vendor: null,
          baseUrl: PLACEHOLDER_BASE_URL,
          status: 0,
        });
      }
      const createdChannel = await deps.stores.channel.insertChannel(tx, {
        providerId: provider.id,
        name: slug,
        apiKeyEnc: deps.cipher.encrypt(PLACEHOLDER_API_KEY),
        rpmLimit: deps.channelRpm,
        upstreamBudget: deps.channelBudget,
      });
      refChannelIds.set(slug, createdChannel.id);
      return createdChannel.id;
    };

    for (const m of input.models) {
      const existingMapping = await deps.stores.model.findByExternalName(tx, m.externalName);
      const prices = {
        inputPrice: m.inputPrice,
        outputPrice: m.outputPrice,
        cacheInputPrice: m.cacheInputPrice,
        cacheWritePrice: m.cacheWritePrice,
      };

      if (source.kind === 'reference') {
        // 字典型：草稿态导入（审批制）——已存在跳过改价（价格属资金语义，改价走正式编辑），
        // 但幂等补绑对应渠道（本功能前导入的旧映射经重导入迁到对应渠道上）
        const refChannelId = await ensureReferenceChannel(m.realModel);
        if (existingMapping) {
          await deps.stores.model.ensureModelChannelBinding(tx, {
            mappingId: existingMapping.id,
            channelId: refChannelId,
          });
          skipped += 1;
          continue;
        }
        const inserted = await deps.stores.model.insertMapping(tx, {
          externalName: m.externalName,
          realModel: m.realModel,
          contextLength: m.contextLength ?? null,
          ...prices,
          isFree: isFreeByPrice(prices),
          status: 1,
        });
        await deps.stores.model.ensureModelChannelBinding(tx, {
          mappingId: inserted.id,
          channelId: refChannelId,
        });
        created += 1;
        continue;
      }

      if (existingMapping) {
        if (existingMapping.realModel !== m.realModel) {
          // 外部名被其他真实模型占用 → 整体回滚（不留半成品）
          throw controlPlaneErrors.business('external_name_conflict', {
            externalName: m.externalName,
            boundTo: existingMapping.realModel,
          });
        }
        // 重复导入 = 价格更新确认（同一真实模型）；isFree 按价格全零重推导
        await deps.stores.model.updateMapping(tx, {
          mappingId: existingMapping.id,
          patch: {
            ...prices,
            isFree: isFreeByPrice(prices),
            ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
          },
        });
        await deps.stores.model.ensureModelChannelBinding(tx, {
          mappingId: existingMapping.id,
          channelId: channelId!,
        });
        updated += 1;
      } else {
        const inserted = await deps.stores.model.insertMapping(tx, {
          externalName: m.externalName,
          realModel: m.realModel,
          contextLength: m.contextLength ?? null,
          ...prices,
          isFree: isFreeByPrice(prices),
        });
        await deps.stores.model.ensureModelChannelBinding(tx, {
          mappingId: inserted.id,
          channelId: channelId!,
        });
        created += 1;
      }
    }
    return { providerId, channelId, created, updated, skipped };
  });

  // 定价审计：目录原价 × fx → 预填 → 提交（全链可复原）
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId: adminIdOf(input.ctx),
    action: source.kind === 'reference' ? 'model_catalog.import_draft' : 'model_catalog.import',
    targetType: source.kind === 'reference' ? 'catalog' : 'provider',
    targetId: String(result.providerId ?? source.id),
    detail: {
      source: source.id,
      kind: source.kind,
      currency: source.priceCurrency,
      fx:
        fxStateNow.baseRate == null
          ? null
          : {
              fxRateId: fxStateNow.fxRateId,
              baseRate: fxStateNow.baseRate,
              effectiveRate: fxStateNow.effectiveRate,
              source: fxStateNow.source,
              fetchedAt: fxStateNow.fetchedAt,
              bufferPct: fxStateNow.bufferPct,
            },
      fetchedAt: new Date(fetchedAt).toISOString(),
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      models: input.models.map((m) => {
        const catalogItem = byReal.get(m.realModel);
        return {
          externalName: m.externalName,
          realModel: m.realModel,
          catalogPrompt: catalogItem?.catalogPrompt ?? null,
          catalogCompletion: catalogItem?.catalogCompletion ?? null,
          prefillInputCny: catalogItem ? prefillOf(catalogItem.catalogPrompt) : null,
          prefillOutputCny: catalogItem ? prefillOf(catalogItem.catalogCompletion) : null,
          submittedInputCny: m.inputPrice,
          submittedOutputCny: m.outputPrice,
        };
      }),
    },
  });
  return result;
}
