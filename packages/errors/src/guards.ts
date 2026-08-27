/**
 * instanceof 守卫：middleware/边界层的精确捕获面——
 * 已知错误精确捕获，其余穿透；宽 catch 是已否决的反模式。
 */
import { BusinessError, DefectError, InfrastructureError, TillgateError } from './nature';

export function isTillgateError(e: unknown): e is TillgateError {
  return e instanceof TillgateError;
}

export function isBusinessError(e: unknown): e is BusinessError {
  return e instanceof BusinessError;
}

export function isInfrastructureError(e: unknown): e is InfrastructureError {
  return e instanceof InfrastructureError;
}

export function isDefectError(e: unknown): e is DefectError {
  return e instanceof DefectError;
}
