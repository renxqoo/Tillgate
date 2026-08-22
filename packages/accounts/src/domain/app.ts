/**
 * Application 域规则:scope 限制项校验(models 条数/条目长度、rpm/tpm 上界注入)。
 * v1 上界:models ≤100 条、每条 ≤64 字符、rpm ≤1e6、tpm ≤1e8(写死 → policy 注入)。
 */
import { FIELD_LIMITS } from './fields.js';
import { parseRateLimit } from './limits.js';

export interface AppScopePolicy {
  readonly rpmLimitMax: number;
  readonly tpmLimitMax: number;
  readonly scopeModelsMax: number;
}

export interface AppScope {
  readonly models?: readonly string[];
  readonly rpm?: number;
  readonly tpm?: number;
}

/** 校验 scope;不合法返回字段名列表(调用方翻译 app_scope_invalid) */
export function validateAppScope(scope: AppScope, policy: AppScopePolicy): string[] | null {
  const invalid: string[] = [];
  if (scope.models !== undefined) {
    if (!Array.isArray(scope.models) || scope.models.length > policy.scopeModelsMax) {
      invalid.push('models');
    } else {
      for (const model of scope.models) {
        if (typeof model !== 'string' || model.length < 1 || model.length > FIELD_LIMITS.modelId) {
          invalid.push('models');
          break;
        }
      }
    }
  }
  if (scope.rpm !== undefined && parseRateLimit(scope.rpm, policy.rpmLimitMax) === null) {
    invalid.push('rpm');
  }
  if (scope.tpm !== undefined && parseRateLimit(scope.tpm, policy.tpmLimitMax) === null) {
    invalid.push('tpm');
  }
  return invalid.length > 0 ? invalid : null;
}
