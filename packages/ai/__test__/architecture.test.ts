/**
 * 边界测试（铁律 11：边界必须可执行；§5.5/§11）：
 *   1. src 全量 import 白名单——内部零 @tokenlens 内部包（永久叶子），外部仅 node 内建、zod、js-tiktoken；
 *   2. src/errors 目录不 import @tokenlens/errors（§11：ai 自有 ErrorKind 封闭词表）；
 *   3. index.ts 导出面快照（值导出集合精确等于下表——新增导出是契约变更）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as exports from '../src/index.js';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SRC = join(import.meta.dirname, '../src');
const files = tsFiles(SRC);

/** 提取真实 import 语句的来源（注释中的字符串不构成依赖） */
function importSources(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
    out.push(m[1]!);
  }
  return out;
}

describe('依赖白名单（§3.6 永久叶子 + §11 错误根契约）', () => {
  it('src 全量零内部依赖：不 import 任何 @tokenlens/*', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const src of importSources(readFileSync(file, 'utf8'))) {
        if (src.startsWith('@tokenlens/')) offenders.push(`${file} -> ${src}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('外部依赖白名单：仅 node:* / zod / js-tiktoken（其余必须走相对路径内部模块）', () => {
    const allowed = new Set(['zod', 'js-tiktoken']);
    const offenders: string[] = [];
    for (const file of files) {
      for (const src of importSources(readFileSync(file, 'utf8'))) {
        const external = !src.startsWith('.') && !src.startsWith('./') && !src.startsWith('node:');
        if (external && !allowed.has(src)) offenders.push(`${file} -> ${src}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/errors/** 不 import @tokenlens/errors（自有 ErrorKind 封闭词表，ADR-0001 D7）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.includes('/errors/')) continue;
      for (const src of importSources(readFileSync(file, 'utf8'))) {
        if (src === '@tokenlens/errors') offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('出口面快照（有意维护的公共接口——新增导出是契约变更）', () => {
  it('index.ts 值导出集合精确等于下表', () => {
    expect(Object.keys(exports).toSorted()).toEqual([
      'DEFAULT_CLAUDE_MAX_TOKENS',
      'KIND_MECHANICS',
      'SUPPORTED_PROTOCOLS',
      'TextFeaturesAccumulator',
      'UpstreamError',
      'aiDefaultsSchema',
      'allowAllUrls',
      'assertSafeUrl',
      'assertSafeUrlSync',
      'canonicalStreamToClaudeStream',
      'canonicalStreamToCompletionsStream',
      'canonicalStreamToGeminiStream',
      'canonicalStreamToResponsesStream',
      'chatResponseToClaude',
      'chatResponseToCompletions',
      'chatResponseToGemini',
      'chatResponseToResponses',
      'claudeRequestToChat',
      'completionsRequestToChat',
      'createAi',
      'defaultAiDefaults',
      'estimateAudioDurationSeconds',
      'extractTextFeatures',
      'geminiRequestToChat',
      'isDeadCredential',
      'isRetryable',
      'isUpstreamError',
      'responsesRequestToChat',
      'vendorProfileNames',
    ]);
  });
});
