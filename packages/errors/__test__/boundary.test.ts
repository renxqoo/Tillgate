import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as api from '../src/index';

/**
 * 边界门禁（铁律 11：边界必须可执行）：
 * 1. 零依赖叶子——运行时依赖与 peer 依赖恒为空（仓库级边界脚本就位后并入 CI 静态检查）；
 * 2. 出口面快照——词表封闭锁 #2，新增导出必须显式改本清单（防止顺手把内部件提升为公共契约）。
 */
/** 依赖表计数：缺省视为 0 项 */
const dependencyCount = (deps?: Record<string, string>): number =>
  deps === undefined ? 0 : Object.keys(deps).length;

describe('包边界', () => {
  it('dependencies / peerDependencies 为空（永久叶子）', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(dependencyCount(pkg.dependencies)).toBe(0);
    expect(dependencyCount(pkg.peerDependencies)).toBe(0);
  });

  it('出口面 == 预期值导出清单（19 项）', () => {
    expect(Object.keys(api).toSorted()).toEqual(
      [
        // 三性根类与传播注记
        'TillgateError',
        'BusinessError',
        'InfrastructureError',
        'DefectError',
        'annotate',
        // category 闭集
        'ERROR_CATEGORIES',
        'CATEGORY_DEFAULTS',
        'isErrorCategory',
        // 错误目录契约
        'defineErrorCatalog',
        'composeErrorCatalogs',
        // 规范化记录
        'recordOf',
        'handlingOf',
        'ROOT_ERROR_CODES',
        'MAX_CAUSE_DEPTH',
        // 边界归一
        'normalizeError',
        // 守卫
        'isTillgateError',
        'isBusinessError',
        'isInfrastructureError',
        'isDefectError',
      ].toSorted(),
    );
  });
});
