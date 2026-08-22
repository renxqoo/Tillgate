/**
 * 目录源适配器测试（网络零依赖：openrouter 经 stubGlobal(fetch)；models.dev 本地快照）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterSource } from '../src/adapters/model-sources/openrouter-source';
import { modelsDevSource } from '../src/adapters/model-sources/models-dev-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openrouter 源（channel 型，装配注入拉取地址与超时）', () => {
  const source = createOpenRouterSource({
    url: 'https://openrouter.example/api/v1/models',
    timeoutMs: 5_000,
  });

  it('源护栏与 id/kind/币种', () => {
    expect(source).toMatchObject({ id: 'openrouter', kind: 'channel', priceCurrency: 'USD' });
    expect(source.channel).toMatchObject({ providerName: 'openrouter', needsKey: true });
  });

  it('fetchModels 拉取 + 每 token 价归一每百万', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
              ],
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch,
    );
    const raw = await source.fetchModels();
    const items = source.mapModels(raw);
    expect(items[0]).toMatchObject({
      realModel: 'openai/gpt-4o',
      catalogPrompt: '2.5',
      catalogCompletion: '10',
    });
  });

  it('非 2xx → 可排障错误（comparison 层翻译 catalog_source_unreachable）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    );
    await expect(source.fetchModels()).rejects.toThrow(/catalog fetch failed.*503/);
  });
});

describe('models.dev 源（reference 型，本地快照零网络）', () => {
  it('快照装载（192 供应商 / 2026-08-20 快照）+ 映射工作', async () => {
    const raw = await modelsDevSource.fetchModels();
    const providers = Object.keys(raw as Record<string, unknown>).filter(
      (k) => k !== '__meta' && k !== '$schema',
    );
    expect(providers.length).toBeGreaterThanOrEqual(190);
    const items = modelsDevSource.mapModels(raw);
    expect(items.length).toBeGreaterThan(1000); // 6840 模型量级（负价哨兵剔除后）
    expect(items.every((i) => i.currency === 'USD')).toBe(true);
  });

  it('源形态：reference / 无渠道护栏', () => {
    expect(modelsDevSource).toMatchObject({ id: 'models-dev', kind: 'reference' });
    expect(modelsDevSource.channel).toBeUndefined();
  });
});
