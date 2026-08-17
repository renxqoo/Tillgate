import { describe, expect, it } from 'vitest';
import { parseEventstreamFrames, eventstreamToClaudeSse, signAwsRequest, parseAwsCredentials } from '../../src/adapters/aws-bedrock';

/** 构造一帧 AWS eventstream（与规范一致：prelude 12B + headers + payload + CRC 忽略） */
function buildFrame(eventType: string, payload: string): Buffer {
  const nameBuf = Buffer.from(':event-type');
  const valueBuf = Buffer.from(eventType);
  const header = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valueBuf.length);
  let o = 0;
  header.writeUInt8(nameBuf.length, o); o += 1;
  nameBuf.copy(header, o); o += nameBuf.length;
  header.writeUInt8(7, o); o += 1; // string
  header.writeUInt16BE(valueBuf.length, o); o += 2;
  valueBuf.copy(header, o);
  const payloadBuf = Buffer.from(payload, 'utf8');
  const total = 12 + header.length + payloadBuf.length + 4;
  const buf = Buffer.alloc(total);
  let p = 0;
  buf.writeUInt32BE(total, p); p += 4;
  buf.writeUInt32BE(header.length, p); p += 4;
  buf.writeUInt32BE(0, p); p += 4; // prelude CRC（解析器不校验）
  header.copy(buf, p); p += header.length;
  payloadBuf.copy(buf, p); p += payloadBuf.length;
  buf.writeUInt32BE(0, p); // message CRC
  return buf;
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

describe('AWS eventstream 解析', () => {
  it('整帧解析：headers + payload 提取', () => {
    const frame = buildFrame('message_start', '{"type":"message_start"}');
    const { frames, rest } = parseEventstreamFrames(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.headers[':event-type']).toBe('message_start');
    expect(frames[0]!.payload.toString('utf8')).toBe('{"type":"message_start"}');
    expect(rest.length).toBe(0);
  });

  it('半帧缓冲：不足一帧时留作 rest，跨 chunk 拼接', () => {
    const frame = buildFrame('content_block_delta', '{"x":1}');
    const { frames, rest } = parseEventstreamFrames(frame.subarray(0, 10));
    expect(frames).toHaveLength(0);
    const merged = Buffer.concat([rest, frame.subarray(10)]);
    const again = parseEventstreamFrames(merged);
    expect(again.frames).toHaveLength(1);
  });

  it('字节流 → claude SSE 事件流（跨 chunk 半帧安全）', async () => {
    const a = buildFrame('message_start', '{"type":"message_start","message":{"id":"m1"}}');
    const b = buildFrame('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}');
    const bytes = Buffer.concat([a, b]);
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        // 故意切成 7 字节小块（跨帧跨 header）
        for (let i = 0; i < bytes.length; i += 7) {
          c.enqueue(new Uint8Array(bytes.subarray(i, Math.min(i + 7, bytes.length))));
        }
        c.close();
      },
    });
    const out = await streamToString(eventstreamToClaudeSse(upstream));
    expect(out).toContain('event: message_start');
    expect(out).toContain('"id":"m1"');
    expect(out).toContain('event: content_block_delta');
    expect(out).toContain('"text":"hi"');
  });
});

describe('SigV4 签名', () => {
  it('产出 AWS4-HMAC-SHA256 头：credential scope / signed headers / 十六进制签名', () => {
    const creds = parseAwsCredentials('AKID:SECRET:SESSION');
    expect(creds).toEqual({ accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'SESSION' });
    const headers = signAwsRequest({
      method: 'POST',
      url: new URL('https://bedrock-runtime.us-west-2.amazonaws.com/model/claude/invoke'),
      body: '{"messages":[]}',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'SESSION' },
      amzDate: new Date('2026-08-17T00:00:00Z'),
    });
    expect(headers['x-amz-date']).toBe('20260817T000000Z');
    expect(headers['x-amz-security-token']).toBe('SESSION');
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20260817\/us-west-2\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date(;x-amz-security-token)?, Signature=[0-9a-f]{64}$/,
    );
    // 确定性：同输入同签名
    const again = signAwsRequest({
      method: 'POST',
      url: new URL('https://bedrock-runtime.us-west-2.amazonaws.com/model/claude/invoke'),
      body: '{"messages":[]}',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'SESSION' },
      amzDate: new Date('2026-08-17T00:00:00Z'),
    });
    expect(again.authorization).toBe(headers.authorization);
    // body 变化 → 签名变化（payload 哈希参与）
    const changed = signAwsRequest({
      method: 'POST',
      url: new URL('https://bedrock-runtime.us-west-2.amazonaws.com/model/claude/invoke'),
      body: '{"messages":[1]}',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'SESSION' },
      amzDate: new Date('2026-08-17T00:00:00Z'),
    });
    expect(changed.authorization).not.toBe(headers.authorization);
  });

  it('非法 apiKey 三段式解析返回 null', () => {
    expect(parseAwsCredentials('only-token')).toBeNull();
    expect(parseAwsCredentials(':secret')).toBeNull();
  });
});
