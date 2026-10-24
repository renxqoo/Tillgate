/**
 * 熔断告警桥（issue #80）：
 * broken=true 入箱 channel_disabled（同渠道×日幂等）；未熔断/无渠道 no-op。
 * TDD 回归：旧实现（无告警桥）在 broken=true 用例上收不到任何入箱。
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
  it('broken=true：入箱 channel_disabled，载荷含渠道/缺陷数，日键幂等', async () => {
    const h = harness();
    const now = new Date('2026-10-25T00:00:00Z');
    await channelBreakAlert(h.notifications, {
      broken: true,
      channelId: 7,
      defects: 5,
      now,
    });
    await channelBreakAlert(h.notifications, {
      broken: true,
      channelId: 7,
      defects: 6,
      now,
    }); // 同日同渠道 → 同 dedupeKey（入箱侧唯一键吸收）
    expect(h.enqueued).toHaveLength(2);
    expect(h.enqueued[0]).toEqual({
      event: 'channel_disabled',
      payload: { channelId: 7, defects: 5, reason: 'usage_evidence_defects' },
      dedupeKey: 'channel-broken:7:20261025',
    });
    expect(h.enqueued[1]?.dedupeKey).toBe(h.enqueued[0]?.dedupeKey);
  });

  it('未熔断 / 无渠道：no-op 不入箱（普通缺陷计数不打扰订阅方）', async () => {
    const h = harness();
    const now = new Date();
    await channelBreakAlert(h.notifications, { broken: false, channelId: 7, defects: 1, now });
    await channelBreakAlert(h.notifications, { broken: true, channelId: null, defects: 5, now });
    expect(h.enqueued).toHaveLength(0);
  });
});
