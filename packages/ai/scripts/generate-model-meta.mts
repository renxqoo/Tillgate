#!/usr/bin/env node
/**
 * 模型元数据生成器（models.dev 单一上游；离线回落本地快照）：
 *
 *   bun run --filter @ai-gateway/ai model-meta                 # 优先抓取 models.dev
 *   bun run --filter @ai-gateway/ai model-meta -- <snapshot.ts> # 离线：解析 pi-ai models.generated.ts
 *
 * 产物（均入库，随包发版）：
 *   1. src/usage/model-meta.generated.ts —— provider:model → contextWindow
 *      （静默溢出兜底判定的数据源；价格不进 ai 包——资金语义归 admin 目录）
 *   2. scripts/output/model-catalog-seed.json —— 完整目录种子（名称/上下文/四维成本/能力位），
 *      供 admin 模型目录导入（审批制：导入为草稿态，管理员复核后启用——价格禁止自动生效）
 *
 * 许可注意：models.dev 数据条款以其站点声明为准；快照回落源为 pi-ai（MIT）生成物。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

interface SeedModel {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  inputs: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** models.dev api.json → 种子（字段形状见 https://models.dev） */
async function fromModelsDev(): Promise<SeedModel[] | null> {
  const url = 'https://models.dev/api.json';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<
      string,
      { models?: Record<string, Record<string, unknown>> }
    >;
    const out: SeedModel[] = [];
    for (const [provider, pd] of Object.entries(data)) {
      if (provider === '__meta' || provider === '$schema') continue;
      for (const model of Object.values(pd.models ?? {})) {
        out.push(toSeed(provider, model));
      }
    }
    return out;
  } catch (err) {
    console.warn(`[model-meta] models.dev 不可达（${(err as Error).message}），尝试本地快照回落`);
    return null;
  }
}

function toSeed(provider: string, m: Record<string, unknown>): SeedModel {
  const limit = (m.limit ?? {}) as { context?: number };
  const cost = (m.cost ?? {}) as Record<string, number>;
  const modalities = (m.modalities ?? {}) as { input?: string[] };
  return {
    provider,
    id: String(m.id ?? ''),
    name: String(m.name ?? m.id ?? ''),
    contextWindow: Number(limit.context ?? 0),
    reasoning: m.reasoning === true,
    inputs: Array.isArray(modalities.input) ? modalities.input.map(String) : ['text'],
    cost: {
      input: Number(cost.input ?? 0),
      output: Number(cost.output ?? 0),
      cacheRead: Number(cost.cache_read ?? 0),
      cacheWrite: Number(cost.cache_write ?? 0),
    },
  };
}

/** pi-ai models.generated.ts（MIT，本地快照）→ 种子（离线回落源） */
async function fromSnapshot(path: string): Promise<SeedModel[]> {
  const mod = (await import(path)) as { MODELS: Record<string, Record<string, Record<string, unknown>>> };
  const out: SeedModel[] = [];
  for (const [provider, models] of Object.entries(mod.MODELS)) {
    for (const m of Object.values(models)) {
      const cost = (m.cost ?? {}) as Record<string, number>;
      out.push({
        provider,
        id: String(m.id ?? ''),
        name: String(m.name ?? m.id ?? ''),
        contextWindow: Number(m.contextWindow ?? 0),
        reasoning: m.reasoning === true,
        inputs: Array.isArray(m.input) ? m.input.map(String) : ['text'],
        cost: {
          input: Number(cost.input ?? 0),
          output: Number(cost.output ?? 0),
          cacheRead: Number(cost.cacheRead ?? 0),
          cacheWrite: Number(cost.cacheWrite ?? 0),
        },
      });
    }
  }
  return out;
}

function emitContextWindowMap(seeds: SeedModel[]): void {
  const byKey = new Map<string, number>();
  const byModel = new Map<string, number>();
  for (const s of seeds) {
    if (!s.id || !Number.isFinite(s.contextWindow) || s.contextWindow <= 0) continue;
    byKey.set(`${s.provider}:${s.id}`, s.contextWindow);
    // 裸模型名冲突取更大窗口（保守：宁可高估窗口不误报溢出）
    const prev = byModel.get(s.id);
    if (prev === undefined || s.contextWindow > prev) byModel.set(s.id, s.contextWindow);
  }
  const lines: string[] = [
    '// 本文件由 scripts/generate-model-meta.mts 生成——勿手改（重跑：bun run --filter @ai-gateway/ai model-meta）',
    `// 数据源：models.dev（快照回落 pi-ai）；生成时间：${new Date().toISOString()}`,
    `// 模型数：${byKey.size}（provider:model 键）+ ${byModel.size}（裸模型名键，冲突取更大窗口）`,
    '',
    '/** provider:model / 裸模型名 → 上下文窗口（静默溢出兜底判定数据源） */',
    'export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {',
  ];
  const keys = [...byKey.entries(), ...byModel.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of keys) lines.push(`  ${JSON.stringify(k)}: ${v},`);
  lines.push('};', '');
  writeFileSync(join(pkgRoot, 'src/usage/model-meta.generated.ts'), lines.join('\n'));
  console.log(`[model-meta] model-meta.generated.ts：${keys.length} 条`);
}

function emitCatalogSeed(seeds: SeedModel[]): void {
  const outDir = join(pkgRoot, 'scripts/output');
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'model-catalog-seed.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        _meta: {
          source: 'models.dev (snapshot fallback: pi-ai models.generated.ts)',
          generatedAt: new Date().toISOString(),
          models: seeds.length,
          note: 'admin 导入为草稿态（审批制），价格属资金语义禁止自动生效；cost 单位 $/1M tokens（models.dev 口径）',
        },
        models: seeds,
      },
      null,
      2,
    ),
  );
  console.log(`[model-meta] model-catalog-seed.json：${seeds.length} 条 → ${path}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  let seeds: SeedModel[] | null = null;
  if (arg === undefined || arg === '--') {
    seeds = await fromModelsDev();
    if (seeds === null) {
      const fallback = join(here, '../../../../pi/packages/ai/src/models.generated.ts');
      if (existsSync(fallback)) {
        console.warn(`[model-meta] 回落本地快照：${fallback}`);
        seeds = await fromSnapshot(fallback);
      }
    }
  } else {
    seeds = await fromSnapshot(arg.startsWith('/') ? arg : join(process.cwd(), arg));
  }
  if (seeds === null || seeds.length === 0) throw new Error('无模型数据（网络不可达且未提供快照路径）');
  emitContextWindowMap(seeds);
  emitCatalogSeed(seeds);
}

void main();
