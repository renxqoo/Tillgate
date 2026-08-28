/**
 * 集成配置完整性：configured = 全部必填字段为非空字符串。
 * effective（enabled && configured）在 application 快照层计算——本层只回答完整性。
 */
import type { IntegrationSpec } from './specs';

export function isConfigComplete(
  spec: IntegrationSpec,
  config: Readonly<Record<string, unknown>>,
): boolean {
  return spec.fields.every((field) => {
    if (!field.required) return true;
    const value = config[field.name];
    return typeof value === 'string' && value.length > 0;
  });
}
