import { describe, expect, it } from 'vitest';
import {
  buildMessageHashChain,
  calibratedChannelAmount,
  calibrationGuard,
  resolveCalibration,
  type CalibrationRecord,
} from '../src/application/calibration.js';

/** C4/构造便利：固定时间基准 */
const NOW = new Date('2026-10-12T00:00:00.000Z');
const RECORD: CalibrationRecord = {
  prefixHash: '',
  channelId: 8,
  inputTokens: 50_000,
  messagesLen: 2,
  settledAt: new Date(NOW.getTime() - 60_000),
};

function chainOf(body: Record<string, unknown>) {
  const chain = buildMessageHashChain({ body });
  if (chain == null) throw new Error('chain fixture must have messages');
  return chain;
}

/** 两轮「只追加」body：第二轮 = 第一轮 + 助手回复 + 新用户消息 */
const TURN1 = {
  system: 'you are helpful',
  tools: [{ type: 'function', name: 'search' }],
  messages: [
    { role: 'user', content: 'hello world' },
    { role: 'user', content: 'second question' },
  ],
};
const TURN2 = {
  ...TURN1,
  messages: [
    ...TURN1.messages,
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'follow up' },
  ],
};

describe('calibrationGuard（C6 适用域）', () => {
  it('chat + 非空 messages → 通过', () => {
    expect(calibrationGuard({ endpoint: 'chat', body: TURN1 })).toBe(true);
  });
  it.each([
    ['embeddings', { input: 'x' }],
    ['images', { prompt: 'x' }],
    ['audio_speech', { text: 'x' }],
    ['chat', { messages: [] }],
    ['chat', {}],
    ['chat', { messages: 'not-array' }],
  ])('%s → 拒绝', (endpoint, body) => {
    expect(calibrationGuard({ endpoint, body: body as Record<string, unknown> })).toBe(false);
  });
});

describe('buildMessageHashChain（哈希链稳定性）', () => {
  it('同内容跨请求字节序稳定（对象字段序乱序输入哈希相等）', () => {
    const a = chainOf({ messages: [{ role: 'user', content: 'x', extra: 1 }] });
    const b = chainOf({ messages: [{ extra: 1, content: 'x', role: 'user' }] });
    expect(a.chainAt(1)).toBe(b.chainAt(1));
  });

  it('只追加：TURN2 在 TURN1 长度处的 chain 与 TURN1 全链相等', () => {
    const c1 = chainOf(TURN1);
    const c2 = chainOf(TURN2);
    expect(c2.chainAt(c1.messageHashes.length)).toBe(c1.chainAt(c1.messageHashes.length));
  });

  it('system/tools 变化 → chain 全变', () => {
    const base = chainOf(TURN1);
    const changed = chainOf({ ...TURN1, system: 'different' });
    expect(changed.chainAt(2)).not.toBe(base.chainAt(2));
  });

  it('早期消息改写 → chain 变', () => {
    const base = chainOf(TURN1);
    const edited = chainOf({
      ...TURN1,
      messages: [{ role: 'user', content: 'hello world EDITED' }, TURN1.messages[1]],
    });
    expect(edited.chainAt(2)).not.toBe(base.chainAt(2));
  });

  it('多模态内容参与哈希：不同图同长度 → 哈希不同（内容哈希，非长度占位）', () => {
    const imgA = chainOf({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    });
    const imgB = chainOf({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }],
        },
      ],
    });
    expect(imgA.chainAt(1)).not.toBe(imgB.chainAt(1));
  });

  it('messages 收缩（下一笔更短）→ chainAt 越长截断到自身长度（不误报匹配）', () => {
    const c2 = chainOf(TURN2);
    // 记录 messagesLen=4 但请求只有 2 条 → resolve 侧 skip；chainAt(4) 截断安全
    expect(c2.chainAt(99)).toBe(c2.chainAt(c2.messageHashes.length));
  });

  it('空 messages → null', () => {
    expect(buildMessageHashChain({ body: { messages: [] } })).toBeNull();
  });
});

describe('resolveCalibration（C1-C6 匹配）', () => {
  const chain1 = chainOf(TURN1);
  const chain2 = chainOf(TURN2);
  const config = { enabled: true, windowMs: 300_000, windowMarginMs: 30_000 };

  function recordOf(over: Partial<CalibrationRecord> = {}): CalibrationRecord {
    return {
      ...RECORD,
      prefixHash: chain1.chainAt(RECORD.messagesLen),
      ...over,
    };
  }

  it('命中：只追加 + 窗口内', () => {
    const r = resolveCalibration({ config, records: [recordOf()], chain: chain2, now: NOW });
    expect(r).toEqual({
      hit: true,
      seen: 50_000,
      prefixHash: chain1.chainAt(2),
      channelId: 8,
      messagesLen: 2,
    });
  });

  it('C2 前缀改写 → no_record（不匹配）', () => {
    const edited = chainOf({
      ...TURN2,
      messages: [{ role: 'user', content: 'EDITED' }, ...TURN2.messages.slice(1)],
    });
    const r = resolveCalibration({ config, records: [recordOf()], chain: edited, now: NOW });
    expect(r).toEqual({ hit: false, missReason: 'no_record' });
  });

  it('C4 超窗 → window miss', () => {
    const stale = recordOf({ settledAt: new Date(NOW.getTime() - 295_000) }); // > window - margin
    const r = resolveCalibration({ config, records: [stale], chain: chain2, now: NOW });
    expect(r).toEqual({ hit: false, missReason: 'window' });
  });

  it('C4 边界：恰在 window - margin 上 → 命中', () => {
    const edge = recordOf({ settledAt: new Date(NOW.getTime() - 270_000) });
    const r = resolveCalibration({ config, records: [edge], chain: chain2, now: NOW });
    expect(r.hit).toBe(true);
  });

  it('messages 收缩（记录比请求长）→ skip 不匹配', () => {
    const longer = recordOf({ messagesLen: 4, prefixHash: chain2.chainAt(4) });
    const r = resolveCalibration({ config, records: [longer], chain: chain1, now: NOW });
    expect(r).toEqual({ hit: false, missReason: 'no_record' });
  });

  it('多条记录：跳过不匹配取首个匹配（top-N 内存过滤语义）', () => {
    const other = recordOf({ prefixHash: 'deadbeef' });
    const r = resolveCalibration({ config, records: [other, recordOf()], chain: chain2, now: NOW });
    expect(r.hit).toBe(true);
  });

  it('disabled 配置由调用方跳过（resolve 本身不判 enabled——quote 层职责）', () => {
    const r = resolveCalibration({
      config: { ...config, enabled: false },
      records: [recordOf()],
      chain: chain2,
      now: NOW,
    });
    expect(r.hit).toBe(true);
  });
});

describe('calibratedChannelAmount（分段公式）', () => {
  const prices = {
    inputPrice: '2.1',
    cacheInputPrice: '0.42',
    cacheWritePrice: null,
    outputPrice: '8.4',
  };

  it('闭式：seen=50000 tail=1000 ratio=0.9', () => {
    const r = calibratedChannelAmount({
      ...prices,
      seen: 50_000,
      tailTokens: 1_000,
      cacheRatio: 0.9,
      maxOutputTokens: 4_096,
    });
    expect(r).not.toBeNull();
    // cacheSeg = 45000 × 0.42/1M = 0.0189
    // rest = 6000 × 2.1/1M = 0.0126
    // output = 4096 × 8.4/1M = 0.0344064
    expect(r?.amount ?? 'null-result').toBe('0.0659064');
  });

  it('写价 > 读价：cacheSeg 取写价（P3 覆盖）', () => {
    const r = calibratedChannelAmount({
      ...prices,
      cacheWritePrice: '4.2',
      seen: 50_000,
      tailTokens: 0,
      cacheRatio: 1.0,
      maxOutputTokens: 0,
    });
    expect(r?.amount ?? 'null-result').toBe('0.21'); // 50000 × 4.2/1M
  });

  it('写价 > 输入价：残留段取写价（增量缓存尾部写）', () => {
    const r = calibratedChannelAmount({
      ...prices,
      cacheWritePrice: '4.2',
      seen: 10_000,
      tailTokens: 10_000,
      cacheRatio: 0.5,
      maxOutputTokens: 0,
    });
    // cacheSeg = 5000 × 4.2/1M = 0.021；rest = 15000 × 4.2/1M = 0.063
    expect(r?.amount ?? 'null-result').toBe('0.084');
  });

  it('ratio 值域外（>1 / ≤0）→ null（防御读侧）', () => {
    expect(
      calibratedChannelAmount({
        ...prices,
        seen: 100,
        tailTokens: 0,
        cacheRatio: 1.5,
        maxOutputTokens: 0,
      }),
    ).toBeNull();
    expect(
      calibratedChannelAmount({
        ...prices,
        seen: 100,
        tailTokens: 0,
        cacheRatio: 0,
        maxOutputTokens: 0,
      }),
    ).toBeNull();
  });

  it('tail 超 seen 巨大 → rest 为正段（无负段）', () => {
    const r = calibratedChannelAmount({
      ...prices,
      seen: 100,
      tailTokens: 1_000_000,
      cacheRatio: 0.9,
      maxOutputTokens: 0,
    });
    expect(r).not.toBeNull();
  });

  it('全零价（免费链不该走到这里，防御）→ 0', () => {
    const r = calibratedChannelAmount({
      inputPrice: '0',
      cacheInputPrice: '0',
      cacheWritePrice: null,
      outputPrice: '0',
      seen: 1_000,
      tailTokens: 100,
      cacheRatio: 0.9,
      maxOutputTokens: 100,
    });
    expect(r?.amount ?? 'null-result').toBe('0');
  });

  it('十进制精度：无浮点误差（P95 高频值的字符串精确性）', () => {
    const r = calibratedChannelAmount({
      ...prices,
      seen: 1,
      tailTokens: 0,
      cacheRatio: 0.9,
      maxOutputTokens: 0,
    });
    // cacheSeg = 0（floor(0.9)=0）→ rest = 1 × 2.1/1M = 0.0000021
    expect(r?.amount ?? 'null-result').toBe('0.0000021');
  });
});
