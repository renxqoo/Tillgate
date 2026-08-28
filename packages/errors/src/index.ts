/**
 * @tillgate/errors 公共出口——内部错误根契约。
 * 出口面刻意极小且由 __test__/boundary.test.ts 快照锁定；新增导出是加法变更，
 * 词表（category/根保留码）变更必须显式改快照并同步全部消费者。
 */

// ---- 三性根类与传播注记 ----
export { TillgateError, BusinessError, InfrastructureError, DefectError, annotate } from './nature';
export type {
  ErrorNature,
  ErrorContext,
  ErrorContextValue,
  ErrorOptions,
  BusinessCode,
  BusinessErrorInit,
} from './nature';

// ---- category 闭集 ----
export { ERROR_CATEGORIES, CATEGORY_DEFAULTS, isErrorCategory } from './category';
export type { ErrorCategory, CategoryDefault } from './category';

// ---- 错误目录契约 ----
export { defineErrorCatalog, composeErrorCatalogs } from './definition';
export type {
  ErrorDefinition,
  ErrorCatalog,
  NamespacedErrorCatalog,
  CatalogEntry,
} from './definition';

// ---- 规范化记录 ----
export { recordOf, handlingOf, ROOT_ERROR_CODES, MAX_CAUSE_DEPTH } from './error-record';
export type {
  ErrorRecord,
  BusinessRecord,
  InfrastructureRecord,
  DefectRecord,
  ErrorHandling,
} from './error-record';

// ---- 边界归一 ----
export { normalizeError } from './normalize';

// ---- 守卫 ----
export { isTillgateError, isBusinessError, isInfrastructureError, isDefectError } from './guards';
