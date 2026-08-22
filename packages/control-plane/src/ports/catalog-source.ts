/**
 * 目录源 port：多源模型目录的适配契约（拉取 + 自带解析 + 源护栏）。
 * 新增源 = 在装配注册一个实现（adapters/model-sources）；本包不预知源集合。
 */
import type { CatalogCurrency, CatalogItem } from '../domain/catalog/catalog';

/** channel 源专属：落库 provider 与渠道护栏（目录源即供应商） */
export interface CatalogChannelGuard {
  readonly providerName: string;
  readonly providerBaseUrl: string;
  readonly providerProtocol: string;
  readonly channelName: string;
  /** 导入是否需要平台 API key（首次建渠道） */
  readonly needsKey: boolean;
}

export interface CatalogSource {
  readonly id: string;
  /** 展示名（前端 Tab） */
  readonly name: string;
  readonly kind: 'channel' | 'reference';
  /** 目录价币种（预填换算与比价口径） */
  readonly priceCurrency: CatalogCurrency;
  readonly channel?: CatalogChannelGuard;
  /** 拉目录原始数据（公开接口；超时/状态码报错由实现负责可排障） */
  fetchModels(): Promise<unknown>;
  /** 原始数据 → 标准目录项（源协议的一部分——非兼容源自带解析） */
  mapModels(raw: unknown): CatalogItem[];
}
