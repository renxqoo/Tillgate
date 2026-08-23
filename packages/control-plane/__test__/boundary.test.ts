/**
 * 边界测试（铁律 11/16：边界必须可执行）：
 * 出口面快照（有意维护的公共接口）/ 依赖方向（禁 http/ai/runtime/app、domain 禁 db）/
 * 错误目录码表封闭（== DESIGN §2.3）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as exports from '../src/index';
import { controlPlaneErrors } from '../src/errors';

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

describe('出口面快照（有意维护的公共接口——新增导出是契约变更）', () => {
  it('index.ts 导出集合精确等于下表', () => {
    expect(Object.keys(exports).toSorted()).toEqual([
      'ADMIN_ROLES',
      'PERMISSION_ACTIONS',
      'PERMISSION_DOMAINS',
      'PRICING_UNITS',
      'applyBuffer',
      'assertAdminRole',
      'assertOperationId',
      'can',
      'commandFingerprint',
      'compareCatalog',
      'controlPlaneErrors',
      'createControlPlane',
      'createMemoryCatalogCache',
      'formatCoefficient',
      'freePriceConsistent',
      'goneFromCatalog',
      'isAdminRole',
      'isFreeByPrice',
      'isUnpriceableSentinel',
      'mapModelsDevCatalog',
      'mapOpenAiCompatibleCatalog',
      'maskUpstreamKey',
      'normalizeBuffer',
      'normalizeRate',
      'parseVoucherDataUrl',
      'permissionsOf',
      'suggestExternalName',
      'toCny',
      'trimNumeric',
      'validateCoefficient',
    ]);
  });

  it('不导出 store/适配器/drizzle 行类型（包内部装配细节）', () => {
    for (const name of Object.keys(exports)) {
      expect(name).not.toMatch(/Store$|^postgres|Source$/);
    }
  });
});

describe('composition 子入口（§5.3：adapter 可见性白名单的可执行形态）', () => {
  it('adapter 只在 composition.ts 导出（根入口零 adapter；G1 起含 postgres store 工厂）', async () => {
    const composition = await import('../src/composition');
    expect(Object.keys(composition).toSorted()).toEqual([
      'createOpenRouterSource',
      'modelsDevSource',
      'postgresChannelStore',
      'postgresModelStore',
      'postgresRateCardStore',
    ]);
  });

  it('业务代码不 import ./composition（仅 assembly/迁移脚本/adapter 集成测试可引用）', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      if (file.endsWith('composition.ts')) continue; // 子入口自身
      const text = readFileSync(file, 'utf-8');
      if (/from\s+['"]\.\/composition['"]|from\s+['"]\.\.\/\.\.\/composition['"]/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('依赖方向（§5 白名单：禁 http/ai/runtime/app；domain 禁 db）', () => {
  const files = tsFiles(SRC);

  it('全包禁止依赖 @tokenlens/http / @tokenlens/ai / @tokenlens/runtime / apps', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // 只匹配真实 import/export-from 语句（注释中的包名不构成依赖）
      if (/from\s+['"]@tokenlens\/(http|ai|runtime)['"]/.test(text)) offenders.push(file);
      if (/from\s+['"]\.\.\/\.\.\/\.\.\/apps\//.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('domain/ 禁止 import db/ports/application/adapters（纯计算层）', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.includes('/domain/'))) {
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"]@tokenlens\/db['"]/.test(text)) offenders.push(file);
      if (/from\s+['"]\.\.\/\.\.\/(ports|application|adapters)\//.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('application/ 禁止 import adapters（只经 ports）', () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => f.includes('/application/'))) {
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"]\.\.\/\.\.\/adapters\//.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('错误目录码表封闭（词表 == DESIGN §2.3）', () => {
  it('码集合快照', () => {
    expect([...controlPlaneErrors.codes].toSorted()).toEqual([
      'control_plane.admin_email_taken',
      'control_plane.admin_not_found',
      'control_plane.catalog_api_key_required',
      'control_plane.catalog_empty',
      'control_plane.catalog_source_not_found',
      'control_plane.catalog_source_unreachable',
      'control_plane.channel_exists',
      'control_plane.channel_has_models',
      'control_plane.channel_not_found',
      'control_plane.external_name_conflict',
      'control_plane.free_price_conflict',
      'control_plane.fx_fetch_failed',
      'control_plane.import_empty',
      'control_plane.import_limit_exceeded',
      'control_plane.insufficient_budget',
      'control_plane.invalid_admin_role',
      'control_plane.invalid_billing_timezone',
      'control_plane.invalid_channel_input',
      'control_plane.invalid_coefficient',
      'control_plane.invalid_fx_buffer',
      'control_plane.invalid_fx_rate',
      'control_plane.invalid_model_input',
      'control_plane.invalid_operation_id',
      'control_plane.invalid_protocol',
      'control_plane.invalid_provider_input',
      'control_plane.invalid_vendor',
      'control_plane.invalid_voucher',
      'control_plane.model_exists',
      'control_plane.model_not_found',
      'control_plane.operation_conflict',
      'control_plane.provider_exists',
      'control_plane.provider_has_channels',
      'control_plane.provider_not_found',
      'control_plane.rate_card_disabled',
      'control_plane.rate_card_in_use',
      'control_plane.rate_card_not_found',
      'control_plane.voucher_too_large',
    ]);
  });
});
