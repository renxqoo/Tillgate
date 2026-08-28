/**
 * 架构边界门禁：目录约定不靠记忆，靠本测试执行。规则：
 * - src 全量 import 白名单：仅 @tillgate/ai、@tillgate/errors + 外部 ioredis/zod
 *   + node: 内建 + 包内相对引用（billing/control-plane 等业务能力经 port 注入，
 *   零编译依赖）；
 * - ioredis（外部 Redis SDK）与 @tillgate/db + drizzle-orm（任务存储 pg 适配器）
 *   只许出现在 src/adapters/**（实现层细节不泄漏）；
 * - 零 billing/control-plane 引用（inference 单向依赖 ai；控制面经 CatalogPort）；
 * - index.ts 导出面快照（公共出口封闭：新增导出必须显式更新本快照）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as index from '../src/index';
import { describe, expect, it } from 'vitest';
import { defined } from './defined';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

interface SourceFile {
  readonly path: string; // 相对 src/
  readonly layer: 'domain' | 'application' | 'ports' | 'adapters' | 'health' | 'root';
  readonly imports: string[];
}

function layerOf(path: string): SourceFile['layer'] {
  if (path.startsWith('domain/')) return 'domain';
  if (path.startsWith('application/')) return 'application';
  if (path.startsWith('ports/')) return 'ports';
  if (path.startsWith('adapters/')) return 'adapters';
  if (path.startsWith('health/')) return 'health';
  return 'root';
}

const files: SourceFile[] = walk(srcDir).map((path) => ({
  path,
  layer: layerOf(path),
  imports: [...readFileSync(`${srcDir}/${path}`, 'utf-8').matchAll(/from\s+'([^']+)'/g)].map((m) =>
    defined(m[1], 'match group'),
  ),
}));

describe('分层依赖白名单（总纲 §5.1 / DESIGN §7 的可执行形态）', () => {
  it('src 全量 import 白名单：@tillgate/ai、@tillgate/errors、ioredis、zod、node:、包内相对引用；db/drizzle 仅 adapters（C-G9）', () => {
    for (const f of files) {
      for (const spec of f.imports) {
        const ok =
          spec.startsWith('node:') ||
          spec.startsWith('./') ||
          spec.startsWith('../') ||
          spec === '@tillgate/ai' ||
          spec === '@tillgate/errors' ||
          spec === 'ioredis' ||
          spec === 'zod' ||
          // 任务存储 pg 适配器依赖 db schema 与 drizzle——仅 adapters 层
          ((spec === '@tillgate/db' || spec === 'drizzle-orm') && f.layer === 'adapters');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });

  it('零 billing / control-plane 引用（跨能力经 port 注入，§5.2；db 归 adapters 白名单另行锁）', () => {
    const banned = [
      '@tillgate/billing',
      '@tillgate/control-plane',
      '@tillgate/accounts',
      '@tillgate/identity',
      '@tillgate/notifications',
      '@tillgate/observability',
      '@tillgate/http',
      '@tillgate/runtime',
    ];
    for (const f of files) {
      for (const spec of f.imports) {
        expect(banned.includes(spec), `${f.path} → ${spec}`).toBe(false);
      }
    }
  });

  it('ioredis 只许出现在 src/adapters/**（外部 SDK 不泄漏上层）', () => {
    for (const f of files) {
      if (f.layer === 'adapters') continue;
      expect(f.imports.includes('ioredis'), `${f.path} → ioredis`).toBe(false);
    }
  });

  it('domain 纯计算：仅 ai/errors 类型与域内相对引用（禁 zod/ioredis/上层目录）', () => {
    for (const f of files.filter((x) => x.layer === 'domain')) {
      for (const spec of f.imports) {
        // 域内相对引用（./ 与 ../）：domain 子目录间互引（usage→model 等）不出 domain 层
        const ok =
          spec.startsWith('node:') ||
          spec === '@tillgate/ai' ||
          spec === '@tillgate/errors' ||
          spec.startsWith('./') ||
          spec.startsWith('../');
        expect(ok, `${f.path} → ${spec}`).toBe(true);
      }
    }
  });
});

/** 剥离块注释与行注释后的代码面（符号检查不因注释误报） */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('公共出口封闭（§5.3：根入口导出面快照）', () => {
  it('index.ts 不 import ioredis / drizzle / db 符号（装配细节不出公共面）', () => {
    const indexSource = stripComments(readFileSync(`${srcDir}/index.ts`, 'utf-8'));
    expect(indexSource.includes('ioredis')).toBe(false);
    expect(indexSource.includes('drizzle')).toBe(false);
    expect(/\bDb\b/.test(indexSource)).toBe(false);
  });

  it('导出面快照（新增/删除导出必须显式更新本快照——契约变更的显式门禁）', () => {
    expect(Object.keys(index).toSorted()).toEqual([
      'ESTIMATE_ATTRIBUTIONS',
      'GENERATION_KINDS',
      'GENERATION_TASK_KINDS',
      'GENERATION_TASK_STATUSES',
      'InferenceErrors',
      'USER_SIDE_CANCELS',
      'buildCandidateChain',
      'canonicalStreamToClaudeStream',
      'canonicalStreamToCompletionsStream',
      'canonicalStreamToGeminiStream',
      'canonicalStreamToResponsesStream',
      'channelHealthKey',
      'chatResponseToClaude',
      'chatResponseToCompletions',
      'chatResponseToGemini',
      'chatResponseToResponses',
      'claudeRequestToChat',
      'completionsRequestToChat',
      'conservativeInputTokenUpperBound',
      'createChannelHealth',
      'createGenerationPollUseCase',
      'createInference',
      'createMemoryGenerationTaskStore',
      'createMemoryHealthStore',
      'createPostgresGenerationTaskStore',
      'createRedisHealthStore',
      'createUpstreamAi',
      'defaultInferenceDefaults',
      'estimateAudioDurationSeconds',
      'geminiRequestToChat',
      'inferenceDefaultsSchema',
      'isAttributedEstimate',
      'isGenerationTaskKind',
      'responsesRequestToChat',
      'streamEstimateAttribution',
    ]);
  });
});
