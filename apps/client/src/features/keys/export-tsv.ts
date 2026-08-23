import type { KeyRow } from '@tokenlens/api-client';

/**
 * Key 导出 TSV 构造（纯函数，B18 增强）：
 *  - 首字符 U+FEFF（UTF-8 BOM）——Excel 直接双击打开中文列不乱码（v1 无 BOM 缺陷修复）；
 *  - 列口径与 v1 一致：name / keyPreview / status / createdAt。
 */
export function buildKeysTsv(keys: ReadonlyArray<KeyRow>): string {
  const lines = ['name\tkeyPreview\tstatus\tcreatedAt'];
  for (const k of keys) {
    lines.push(
      `${k.name}\t${k.keyPreview}\t${k.status === 0 ? 'active' : 'revoked'}\t${k.createdAt}`,
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}
