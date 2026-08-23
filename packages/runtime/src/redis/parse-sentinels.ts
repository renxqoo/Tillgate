/**
 * Sentinel 拓扑串解析（装配期 fail-fast）——拆分自 v2 原 redis-client.ts
 * （一动词一文件，铁律 5）。端口按严格十进制 1-65535 校验：
 * Number() 宽松解析会放行 '0x1e' / '1e2' / 带空白形态（P3 加固），装配缺陷不得静默通过。
 */
import { DefectError } from '@tokenlens/errors';

/** sentinel 拓扑串解析："h:26379,h:26379" → [{host, port}]（非法项抛错——装配期 fail-fast） */
export function parseSentinels(spec: string): { host: string; port: number }[] {
  const nodes = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((node) => {
      // lastIndexOf 切分（而非 split）：IPv6 形态 [::1]:26379 只切末段端口
      const idx = node.lastIndexOf(':');
      const host = idx > 0 ? node.slice(0, idx) : node;
      const portStr = idx > 0 ? node.slice(idx + 1) : '26379';
      const port = Number(portStr);
      if (
        !host ||
        !/^[0-9]{1,5}$/.test(portStr) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        throw new DefectError(
          `invalid REDIS_SENTINELS node: ${node} (expected comma-separated host:port with decimal port 1-65535)`,
          'runtime.redis.sentinels_invalid',
          { node },
        );
      }
      return { host, port };
    });
  if (nodes.length === 0) {
    throw new DefectError(
      'REDIS_SENTINELS is empty (expected comma-separated host:port)',
      'runtime.redis.sentinels_invalid',
    );
  }
  return nodes;
}
