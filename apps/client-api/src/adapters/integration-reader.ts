/**
 * client-api 集成设置 reader 装配件：
 * postgres reader + OAuth 基地址（env 来源：部署拓扑，装配期生效，
 * 变更需重启——与 env 语义天然一致；base 不来自集成表）。
 */
import { createPostgresIntegrationSettingsReader } from '@tillgate/control-plane/composition';
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import type { Db } from '@tillgate/db';
import { createCipher, type Logger } from '@tillgate/runtime';

/** 本地缺省（env 未配时回落） */
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
  /** OAuth 基地址（env `OAUTH_API_BASE`/`OAUTH_FRONTEND_URL`） */
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
