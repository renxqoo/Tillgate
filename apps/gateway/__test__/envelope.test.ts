/**
 * 成功信封契约（v1 encodeResult 三态 + SSE 头组语义迁移）：
 * 流式字节透传头组 / 二进制 rawBody / JSON 三态 / codec 编码 / passthrough（ADR-0004）。
 */
import { describe, expect, it } from 'vitest';
import { encodeDelivered, sseResponse } from '../src/http/openai-envelope';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('sseResponse', () => {
  it('SSE 头组齐全：no-cache / keep-alive / x-accel-buffering:no / x-request-id', () => {
    const res = sseResponse(new ReadableStream(), 'req-1');
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('x-request-id')).toBe('req-1');
  });
});

describe('encodeDelivered 三态', () => {
  it('流式交付：直传流（无 codec 不转换——字节等价）；有 codec 走线格式转换流', async () => {
    const chunks: string[] = ['data: a\n\n', 'data: b\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const res = await encodeDelivered(json, { ok: true, status: 200, stream, contentType: 'text/event-stream' } as never, {
      model: 'm',
      requestId: 'r',
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const text = await res.text();
    expect(text).toBe(chunks.join(''));

    const converted = await encodeDelivered(
      json,
      {
        ok: true,
        status: 200,
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('raw'));
            c.close();
          },
        }),
        contentType: 'text/event-stream',
      } as never,
      { model: 'm', requestId: 'r', encodeStream: (s) => s },
    );
    expect(await converted.text()).toBe('raw');
  });

  it('rawBody：二进制 200 + 原始 content-type + x-request-id', async () => {
    const res = await encodeDelivered(
      json,
      { ok: true, status: 200, rawBody: new Uint8Array([1, 2, 3]), rawContentType: 'audio/mpeg' },
      { model: 'm', requestId: 'r-9' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('x-request-id')).toBe('r-9');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('JSON：200 时 codec 编码回外部线格式；非 200 原样出站', async () => {
    const encoded = await encodeDelivered(
      (_b, s) => json({ wrapped: true }, s),
      { ok: true, status: 200, body: { internal: true } },
      { model: 'm', requestId: 'r', encodeResponse: (b) => ({ wrapped: (b as object) !== null }) },
    );
    expect(await encoded.json()).toEqual({ wrapped: true });

    const passthroughStatus = await encodeDelivered(
      json,
      { ok: true, status: 402 as never, body: { error: { code: 'x' } } },
      { model: 'm', requestId: 'r', encodeResponse: () => ({ never: true }) },
    );
    expect(passthroughStatus.status).toBe(402);
    expect(await passthroughStatus.json()).toEqual({ error: { code: 'x' } });
  });

  it('passthrough（上游 4xx 透传，ADR-0004）：原码 + code/message 出站', async () => {
    const res = await encodeDelivered(
      json,
      { ok: true, passthrough: true, status: 422, code: 'invalid_prompt', message: 'prompt too long' },
      { model: 'm', requestId: 'r' },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 'invalid_prompt', message: 'prompt too long' } });
  });

  it('rawBody 无 content-type 时缺省 application/octet-stream', async () => {
    const res = await encodeDelivered(
      json,
      { ok: true, status: 200, rawBody: new Uint8Array([9]) },
      { model: 'm', requestId: 'r' },
    );
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});
