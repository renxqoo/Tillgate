import { Hono } from 'hono';
import { SUPPORTED_PROTOCOLS } from '@ai-gateway/ai';
import type { AdminEnv } from '@ai-gateway/identity';
import { VENDOR_CATALOG } from '../services/vendor-catalog.js';

/**
 * 厂商档案目录（静态清单，无 DB）：
 * 创建 Provider 时的 baseUrl 预设（全部 openai-compatible）+ 协议词表透出。
 * 词表单一真相——ai 包适配器注册表 / vendor-catalog.ts。
 */
export function vendorCatalogRoutes(): Hono<AdminEnv> {
  return new Hono<AdminEnv>().get('/', (c) =>
    c.json({
      protocols: SUPPORTED_PROTOCOLS,
      vendors: VENDOR_CATALOG,
    }),
  );
}
