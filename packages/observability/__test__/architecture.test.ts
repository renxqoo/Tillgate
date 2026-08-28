/**
 * 边界测试(边界必须可执行):
 * 出口面快照(根 + ./composition)/ 依赖白名单(禁 http/ai/runtime/能力包/apps;
 * OTel 只在 telemetry;drizzle 只在 adapters;adapters 只由 facade 与 composition 装配)/
 * 错误目录码表封闭。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as exports from '../src/index';
import * as composition from '../src/composition';
import { observabilityErrors } from '../src/errors';

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

describe('出口面快照(有意维护的公共接口——新增导出是契约变更)', () => {
  it('index.ts 值导出集合精确等于下表', () => {
    expect(Object.keys(exports).toSorted()).toEqual([
      'BEIJING_ZONE_OFFSET_MS',
      'SpanStatusCode',
      'USAGE_SORT_FIELDS',
      'beijingDayStart',
      'beijingTrendsFrom',
      'buildTraceGraph',
      'context',
      'createLogSpanProcessor',
      'createMemoryTraceViewer',
      'createObservability',
      'createSpanBatcher',
      'createTraceQueries',
      'createUsageQueries',
      'dayKey',
      'decodeOtlpJson',
      'formatTraceParent',
      'getMeter',
      'getTracer',
      'initOtel',
      'metrics',
      'observabilityErrors',
      'remoteParentContext',
      'shiftDay',
      'trace',
      'withAsyncSpan',
    ]);
  });

  it('不导出 store/适配器/drizzle 行类型(包内部装配细节)', () => {
    for (const name of Object.keys(exports)) {
      expect(name).not.toMatch(/Store$|^postgres|^pg/i);
    }
  });

  it('composition.ts 值导出集合精确等于下表(apps assembly 专用)', () => {
    expect(Object.keys(composition).toSorted()).toEqual([
      'createBestEffortAuditSink',
      'createPgAuditQueries',
      'createPgRequestLogStore',
      'createPgTraceStore',
      'ensureTracePartition',
      'listTracePartitionDays',
      'maintainRequestLogPartitions',
      'maintainTracePartitions',
      'writeAudit',
    ]);
  });
});

describe('依赖方向(§5 白名单:禁 http/ai/runtime/能力包/apps)', () => {
  it('全包禁止依赖 http / ai / runtime / 业务能力包 / apps', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // 只匹配真实 import/export-from 语句(注释中的包名不构成依赖)
      if (
        /from\s+['"]@tillgate\/(http|ai|runtime|accounts|billing|control-plane|inference|identity|notifications)['"]/.test(
          text,
        )
      ) {
        offenders.push(file);
      }
      if (/from\s+['"]\.\.\/\.\.\/\.\.\/apps\//.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('@opentelemetry/* 只出现在 telemetry/**(telemetry 词汇出口 index.ts 除外)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes('/telemetry/') || file.endsWith('index.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"]@opentelemetry\//.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('drizzle-orm 只出现在 adapters/postgres/**(纯逻辑层零 SQL 构造)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes('/adapters/postgres/')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"]drizzle-orm['"]/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('@tillgate/db 值导入只出现在 adapters/postgres/**;非 adapter 只许 type-only', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes('/adapters/postgres/')) continue;
      // 先剔除 import type 行,剩下的若有 db 引用即为值导入
      const text = readFileSync(file, 'utf8').replace(/^import\s+type[^\n]*\n/gm, '');
      if (/from\s+['"]@tillgate\/db['"]/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('adapters 只由 observability.ts facade 与 composition.ts 装配', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(SRC.length + 1);
      if (rel === 'observability.ts' || rel === 'composition.ts') continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"]\.{1,2}(\/\.\.)*\/adapters\//.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('composition 子入口不被包内业务代码引用(apps assembly 专用,§5.3)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('composition.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*\/composition['"]/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('错误目录码表封闭(== DESIGN §4)', () => {
  it('observabilityErrors 恰为三码且命名空间正确', () => {
    expect(observabilityErrors.codes.toSorted()).toEqual([
      'observability.invalid_otlp_payload',
      'observability.invalid_partition_day',
      'observability.otel_endpoint_missing',
      'observability.otel_option_missing',
    ]);
  });
});
