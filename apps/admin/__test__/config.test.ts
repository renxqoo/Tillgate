/**
 * config 契约测试：app-config 形状。
 * 协议/厂商档案词表的单一真相 = admin-api `GET /v1/vendor-catalog`（ai 根出口装配）。
 */
import { describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../src/config/app-config';

describe('app-config', () => {
  it('应用名/版本元数据形状', () => {
    expect(typeof APP_CONFIG.name).toBe('string');
    expect(APP_CONFIG.name.length).toBeGreaterThan(0);
    expect(APP_CONFIG).toHaveProperty('meta');
  });
});
