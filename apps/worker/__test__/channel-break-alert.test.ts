/**
 * 熔断告警桥（issue #80）：
 * broken=true 入箱 channel_disabled；未熔断/无渠道 no-op。
 * 幂等键 = 渠道 × 触发请求：同一熔断事件的结算重试同键吸收，
 * 复核启用后再熔断（新事件新 requestId）必告警——反弹场景不丢告警。
 */
import { describe, expect, it } from 'vitest';
import { channelBreakAlert } from '../src/channel-break-alert';

interface Enqueued {
  event: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
}

function harness() {
  const enqueued: Enqueued[] = [];
  const notifications = {
    async enqueue(input: Enqueued): Promise<void> {
      enqueued.push(input);
    },
  };
  return { notifications, enqueued };
}

describe('channelBreakAlert', () => {
  it('broken=true：入箱 channel_disabled，幂等键 = 渠道 × 触发请求', async () => {
    const h = harness();
    await channelBreakAlert(h.notifications, {
      broken: true,
      channelId: 7,
      defects: 5,
      requestId: 'req-a',
      breakReason: 'usage_defects',
    });
    expect(h.enqueued).toEqual([
      {
        event: 'channel_disabled',
        payload: { channelId: 7, defects: 5, reason: 'usage_defects' },
        dedupeKey: 'channel-broken:7:req-a',
      },
    ]);
  });

  it('同日同渠道再熔断（新触发请求）：新键必入箱——反弹场景告警不被 dedupe 吞（路 C finding #1）', async () => {
    const h = harness();
    await channelBreakAlert(h.notifications, {
      broken: true,
      channelId: 7,
      defects: 5,
      requestId: 'req-a', // 第一次熔断
      breakReason: 'usage_defects',
    });
    // 复核启用（计数清零）→ 同日再累计到 5 再熔断：defects 相同但事件不同
    await channelBreakAlert(h.notifications, {
      broken: true,
      channelId: 7,
      defects: 5,
      requestId: 'req-b', // 再熔断的触发结算
      breakReason: 'usage_defects',
    });
    expect(h.enqueued).toHaveLength(2);
    expect(new Set(h.enqueued.map((e) => e.dedupeKey)).size).toBe(2); // 键不同 → 入箱侧均落库
  });

  it('未熔断 / 无渠道：no-op 不入箱（普通缺陷计数不打扰订阅方）', async () => {
    const h = harness();
    await channelBreakAlert(h.notifications, {
      broken: false,
      channelId: 7,
      defects: 1,
      requestId: 'r',
      breakReason: null,
    });
    await channelBreakAlert(h.notifications, {
      broken: true,
      channelId: null,
      defects: 5,
      requestId: 'r',
      breakReason: 'budget_exhausted',
    });
    expect(h.enqueued).toHaveLength(0);
  });
});
