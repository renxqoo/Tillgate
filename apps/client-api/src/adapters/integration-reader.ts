/**
 * client-api 集成设置 reader 装配件（assembly 拆件——铁律 22 文件行数收口）：
 * postgres reader + OAuth 基地址（ADR-0012 退回 env：部署拓扑，装配期生效，
 * 变更需重启——与 env 语义天然一致；原「boot 读 DB fail-loud」随之移除，
 * base 不再来自集成表）。
 */
import { createPostgresIntegrationSettingsReader } from '@tillgate/control-plane/composition';
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import type { Db } from '@tillgate/db';
import { createCipher, type Logger } from '@tillgate/runtime';

/** 本地缺省（env 未配时——与原「无行」回退同口径，DESIGN §3.3） */
const LOCAL_API_BASE = 'http://localhost:8081';
const LOCAL_FRONTEND_URL = 'http://localhost:3000';

export interface IntegrationReaderBoot {
  readonly reader: IntegrationSettingsReader;
  /** API 根地址（env `OAUTH_API_BASE`；回调白名单装配期由它构建） */
  readonly apiBase: string;
  /** 前端根地址（env `OAUTH_FRONTEND_URL`，未配 = null——forgot 链路 fail-closed 语义保持） */
  readonly frontendUrl: string | null;
  /** frontendUrl 是否来自显式配置（缺省回落不算已配置） */
  readonly frontendUrlConfigured: boolean;
}

export async function bootIntegrationReader(input: {
  db: Db;
  encryptionKey: string;
  logger: Logger;
  /** OAuth 基地址（env `OAUTH_API_BASE`/`OAUTH_FRONTEND_URL`——ADR-0012） */
  oauthBase?: { apiBase?: string; frontendUrl?: string };
}): Promise<IntegrationReaderBoot> {
  const { db, encryptionKey, logger, oauthBase } = input;
  const reader = createPostgresIntegrationSettingsReader({
    db,
    cipher: createCipher(encryptionKey),
    onError: (error: unknown) =>
      logger.warn({ err: error }, 'integration settings background refresh failed'),
  });
  const frontendUrl = oauthBase?.frontendUrl ?? null;
  return {
    reader,
    apiBase: oauthBase?.apiBase ?? LOCAL_API_BASE,
    frontendUrl,
    frontendUrlConfigured: frontendUrl != null,
  };
}

export const OAUTH_LOCAL_DEFAULTS = {
  apiBase: LOCAL_API_BASE,
  frontendUrl: LOCAL_FRONTEND_URL,
} as const;
