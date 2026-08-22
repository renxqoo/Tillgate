/**
 * 拼接上游 URL（new-api #3133 同类问题）：baseUrl 尾段是版本段
 * （/v1、/v2…）且与适配器路径首段相同时去重——管理员按 OpenAI 文档惯例填
 * `https://host/v1` 时不得拼出 `/v1/v1/chat/completions`（404 且与配置
 * 根源无关，极难排查）。版本段之外的内容（如 openrouter 的 `/api`）不动。
 */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const versionSeg = /\/(v\d+)(?=\/)/i.exec(path);
  const baseTail = base.split('/').pop() ?? '';
  if (versionSeg && versionSeg[1]!.toLowerCase() === baseTail.toLowerCase()) {
    return base + path.slice(versionSeg[0]!.length);
  }
  return base + path;
}
