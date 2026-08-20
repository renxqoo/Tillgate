/**
 * models.dev 本地快照生成器：
 *   拉取 https://models.dev/api.json → src/services/models-dev.snapshot.generated.ts
 *   （运行时零网络：admin-api 目录源直接读模块；重跑：pnpm --filter admin-api models-dev:refresh）
 *
 * 网络说明：Node fetch 不读系统代理——本机被墙时需 CATALOG_PROXY_URL（或 HTTPS_PROXY）
 * 指定代理（如 Clash http://127.0.0.1:7897）；未配置 = 直连。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '../src/services/models-dev.snapshot.generated.ts');

const proxyUrl = process.env.CATALOG_PROXY_URL ?? process.env.HTTPS_PROXY ?? null;
const res = await undiciFetch('https://models.dev/api.json', {
  signal: AbortSignal.timeout(30_000),
  ...(proxyUrl ? { dispatcher: new ProxyAgent({ uri: proxyUrl, connectTimeout: 10_000 }) } : {}),
});
if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
const snapshot = (await res.json()) as Record<string, unknown>;

const providers = Object.keys(snapshot).filter((k) => k !== '__meta' && k !== '$schema');
const models = providers.reduce((sum, p) => sum + Object.keys((snapshot[p] as { models?: object })?.models ?? {}).length, 0);

const header = `// 本文件由 scripts/fetch-models-dev.mts 生成——勿手改（重跑：pnpm --filter admin-api models-dev:refresh）
// 数据源：https://models.dev/api.json；生成时间：${new Date().toISOString()}
// 规模：${providers.length} 供应商 / ${models} 模型（负价哨兵等清洗在 mapModelsDevCatalog 运行时做）

/** models.dev 快照（原始 api.json 形状；消费方 mapModelsDevCatalog 接受 unknown） */
export const MODELS_DEV_SNAPSHOT: Record<string, unknown> = ${JSON.stringify(snapshot)} as const;
`;

writeFileSync(outPath, header);
console.log(`snapshot written: ${outPath} (${providers.length} providers / ${models} models)`);
