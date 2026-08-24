/**
 * client-api 集成设置 reader 装配件（assembly 拆件——铁律 22 文件行数收口）：
 * postgres reader + OAuth 基地址装配期 boot 解析（DESIGN §5 D4/D9）。
 * boot 读失败 best-effort 回落本地缺省（进程启动不因集成表不可达而拒绝——
 * 后续 latest()/resolve() 按 TTL 继续重试）。
 */
import { createPostgresIntegrationSettingsReader } from '@tillgate/control-plane/composition';
import type { IntegrationSettingsReader } from '@tillgate/control-plane';
import type { Db } from '@tillgate/db';
import { createCipher, type Logger } from '@tillgate/runtime';

/** 本地缺省（oauth.base 无行时——与原 env 缺省同口径，DESIGN §3.3） */
const LOCAL_API_BASE = 'http://localhost:8081';

export interface IntegrationReaderBoot {
  readonly reader: IntegrationSettingsReader;
  /** 装配期 boot 解析（D9 收窄：回调白名单是装配期契约，变更需重启） */
  readonly apiBase: string;
  /** 前端基地址（boot 快照；无行 = null——forgot 链路 fail-closed 语义保持） */
  readonly frontendUrl: string | null;
}

export async function bootIntegrationReader(
  db: Db,
  encryptionKey: string,
  logger: Logger,
): Promise<IntegrationReaderBoot> {
  const reader = createPostgresIntegrationSettingsReader({
    db,
    cipher: createCipher(encryptionKey),
    onError: (error: unknown) =>
      logger.warn({ err: error }, 'integration settings background refresh failed'),
  });
  try {
    const boot = await reader.resolve();
    return {
      reader,
      apiBase: boot.oauth.base.config?.apiBase ?? LOCAL_API_BASE,
      frontendUrl: boot.oauth.base.config?.frontendUrl ?? null,
    };
  } catch (error) {
    logger.warn({ err: error }, 'integration settings boot read failed (fallback defaults)');
    return { reader, apiBase: LOCAL_API_BASE, frontendUrl: null };
  }
}
