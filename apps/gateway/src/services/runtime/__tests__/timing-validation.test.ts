import { describe, expect, it } from 'vitest';
import { assertGatewayTiming } from '../timing-validation.js';

describe('assertGatewayTiming — 时序不变量', () => {
  const base = { deadlineMs: 240_000, inactivityMs: 300_000, firstByteMs: 300_000, shutdownGraceMs: 30_000 };

  it('deadline 覆盖不了预算总和（默认 240s < 600s）必须被拒绝', () => {
    expect(() => assertGatewayTiming(base)).toThrow(/GATEWAY_REQUEST_DEADLINE_MS/);
  });

  it('deadline 覆盖预算总和时通过', () => {
    expect(() => assertGatewayTiming({ ...base, deadlineMs: 700_000 })).not.toThrow();
  });

  it('停机宽限过小被拒绝', () => {
    expect(() =>
      assertGatewayTiming({ ...base, deadlineMs: 700_000, shutdownGraceMs: 4_000 }),
    ).toThrow(/SHUTDOWN_GRACE/);
  });
});
