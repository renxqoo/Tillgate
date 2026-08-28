/**
 * RBAC 启动对账契约（原内嵌 assembly 的 IIFE 上移进程入口后，拒启分支首次可测）：
 * 全码在 → 放行;缺种子码 → 拒启(fail-closed,绝不静默全站 403);
 * DB 不可达 → 降级告警不杀进程(本地/单测形态)。
 */
import { describe, expect, it, vi } from 'vitest';
import { ENFORCED_CODES } from '@tillgate/control-plane';
import { verifyRbacStartup } from '../src/startup-rbac';

function harness(activeCodes: () => Promise<readonly string[]>) {
  const error = vi.fn();
  const warn = vi.fn();
  const exit = vi.fn();
  verifyRbacStartup({
    activeCodes,
    logger: { error, warn } as never,
    exit,
  });
  return { error, warn, exit };
}

describe('verifyRbacStartup', () => {
  it('全 enforced 码在 DB → 放行:零 exit 零日志', async () => {
    const h = harness(async () => [...ENFORCED_CODES]);
    // 空转一拍让 IIFE 落定(无输出即通过)
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('缺一个种子码 → exit(1) + error 定位该码(拒启不静默全站 403)', async () => {
    const [missing] = ENFORCED_CODES;
    const rest = [...ENFORCED_CODES].slice(1);
    const h = harness(async () => rest);
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(1));
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error.mock.calls[0]?.[0]).toMatchObject({ code: missing });
  });

  it('DB 不可达(activeCodes 拒绝) → 降级 warn,不杀进程', async () => {
    const h = harness(async () => {
      throw new Error('db unreachable');
    });
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(1));
    expect(h.exit).not.toHaveBeenCalled();
  });
});
