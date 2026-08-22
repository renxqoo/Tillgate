/**
 * models.dev 本地快照生成器：
 *   拉取 https://models.dev/api.json → packages/control-plane/src/adapters/model-sources/models-dev-snapshot.json
 *   （运行时零网络：目录源直接读本地快照；重跑：bun scripts/fetch-models-dev.ts）
 *
 * 网络说明：Node fetch 不读系统代理——本机被墙时需 CATALOG_PROXY_URL（或 HTTPS_PROXY）
 * 指定代理（如 Clash http://127.0.0.1:7897）；未配置 = 直连。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const proxyUrl = process.env.CATALOG_PROXY_URL ?? process.env.HTTPS_PROXY ?? null;
const doFetch: typeof fetch = async (input, init) => {
  if (!proxyUrl) return fetch(input, init);
  // Bun 原生 fetch 支持 proxy 选项（undici ProxyAgent 的 Bun 对应面）
  return fetch(input, { ...init, proxy: proxyUrl } as Parameters<typeof fetch>[1]);
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(
  here,
  '../packages/control-plane/src/adapters/model-sources/models-dev-snapshot.json',
);

const res = await doFetch('https://models.dev/api.json', { signal: AbortSignal.timeout(30_000) });
if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
const snapshot = (await res.json()) as Record<string, unknown>;

const providers = Object.keys(snapshot).filter((k) => k !== '__meta' && k !== '$schema');
const models = providers.reduce(
  (sum, p) => sum + Object.keys((snapshot[p] as { models?: object })?.models ?? {}).length,
  0,
);

writeFileSync(outPath, JSON.stringify(snapshot));
console.log(
  `snapshot written: ${outPath} (${providers.length} providers / ${models} models, generated ${new Date().toISOString()})`,
);
