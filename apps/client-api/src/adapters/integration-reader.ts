/**
 * client-api 集成设置 reader 装配件（assembly 拆件——铁律 22 文件行数收口）：
 * postgres reader + OAuth 基地址装配期 boot 解析（DESIGN §5 D4/D9）。
 * boot 读失败 fail-loud（review 修复 B-suspect2）：apiBase/frontendUrl 装配期冻结
 * 且不自愈，静默回落 localhost 会把 OAuth/找回面带病上线——集成表不可达应拒绝启动；
 * 仅「无行」回落本地缺省（§3.3）。
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
  /** frontendUrl 是否来自显式配置（review 修复：取代魔法串反推，缺省值不算已配置） */
  readonly frontendUrlConfigured: boolean;
}

export async function bootIntegrationReader(
  db: Db,
  encryptionKey: string,
  _logger: Logger,
): Promise<IntegrationReaderBoot> {
  const reader = createPostgresIntegrationSettingsReader({
    db,
    cipher: createCipher(encryptionKey),
    onError: (error: unknown) =>
      _logger.warn({ err: error }, 'integration settings background refresh failed'),
  });
  const boot = await reader.resolve(); // 读失败向上抛（fail-loud——见文件头）
  const frontendUrl = boot.oauth.base.config?.frontendUrl ?? null;
  return {
    reader,
    apiBase: boot.oauth.base.config?.apiBase ?? LOCAL_API_BASE,
    frontendUrl,
    frontendUrlConfigured: frontendUrl != null,
  };
}
