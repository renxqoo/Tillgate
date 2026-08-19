import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/adapters/openai-compatible.js';
import { responsesRequestToChat } from '../../src/protocol/responses-chat.js';
import { classifyBodyOnlyError, classifyHttpError, classifyTransportError } from '../../src/errors/classify.js';
import { assertSafeUrlSync } from '../../src/transport/http-client.js';
import type { Endpoint } from '../../src/types.js';

/** 终局分支补齐：端点寻址全枚举 / responses 解码臂 / classify 提取臂 / SSRF 同步臂 */
describe('openai-compatible 端点寻址全枚举', () => {
  const adapter = new OpenAICompatibleAdapter();
  const channel = { baseUrl: 'https://api.test', apiKey: 'sk', protocol: 'openai-compatible' };
  const paths: Array<[Endpoint, string]> = [
    ['chat', '/v1/chat/completions'],
    ['embeddings', '/v1/embeddings'],
    ['images', '/v1/images/generations'],
    ['images_edits', '/v1/images/edits'],
    ['audio_speech', '/v1/audio/speech'],
    ['audio_transcription', '/v1/audio/transcriptions'],
    ['audio_translation', '/v1/audio/translations'],
    ['rerank', '/v1/rerank'],
    ['moderations', '/v1/moderations'],
  ];
  it.each(paths)('endpoint=%s → %s', (endpoint, path) => {
    const plan = adapter.planRequest(channel, { endpoint, model: 'm', requestId: 'r', stream: false });
    expect(plan.path).toBe(path);
    expect(plan.headers.authorization).toBe('Bearer sk');
  });

  it('map 规则指向缺省参数不产生 adjustment；ignore 缺省参数同样静默', () => {
    const out = adapter.normalizeRequest(
      { model: 'm' },
      { map: { absent: { to: 'x' } }, ignore: ['also_absent'] },
    );
    expect(out).toEqual({ body: { model: 'm' }, adjustments: [] });
  });
});

describe('responses 解码臂', () => {
  it('developer/system 角色、contentOf 字符串与块数组、温度/top_p/stream 透传', () => {
    const out = responsesRequestToChat({
      model: 'm',
      input: [
        { type: 'message', role: 'developer', content: 'dev 系统词' },
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'sys 块' }] },
        { type: 'message', role: 'assistant', content: '助手指令' },
        { type: 'message', role: 'unknown_role', content: '被防御跳过' },
      ],
      temperature: 0.2,
      top_p: 0.7,
      stream: true,
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'dev 系统词' },
      { role: 'system', content: 'sys 块' },
      { role: 'assistant', content: '助手指指' },
    ].map((m, i) => (i === 2 ? { role: 'assistant', content: '助手指令' } : m)));
    expect(out).toMatchObject({ temperature: 0.2, top_p: 0.7, stream: true });
  });

  it('input 非数组（对象/null）→ 空消息防御', () => {
    expect(responsesRequestToChat({ model: 'm', input: { a: 1 } }).messages).toEqual([]);
    expect(responsesRequestToChat(null).messages).toEqual([]);
  });
});

describe('classify 提取臂', () => {
  it('error.code 优先、error.type 兜底、顶层 code 最后', () => {
    expect(classifyHttpError(400, { error: { code: 'E1', type: 'T1' }, code: 'C1' }).code).toBe('E1');
    expect(classifyHttpError(400, { error: { type: 'T1' }, code: 'C1' }).code).toBe('T1');
    expect(classifyHttpError(400, { code: 'C1' }).code).toBe('C1');
    expect(classifyHttpError(400, { error: '字符串错误' }).code).toBe('invalid_request');
  });

  it('message 提取：顶层 message 兜底、纯字符串 body', () => {
    expect(classifyHttpError(500, { message: '顶层消息' }).message).toBe('顶层消息');
    expect(classifyHttpError(500, '纯字符串').rawBody).toBe('纯字符串');
    expect(classifyTransportError('network').suggestion).toBeUndefined();
  });

  it('body-only：error.type 含 rate 形态 / 死凭据形态 / 403 文本特征', () => {
    expect(classifyBodyOnlyError({ error: { type: 'rate_limit_exceeded', message: 'x' } })?.code).toBe('rate_limited');
    expect(classifyBodyOnlyError({ error: { message: 'Incorrect API key provided' } })?.deadCredential).toBe(true);
    expect(classifyHttpError(403, { error: { message: 'unauthorized access' } }).deadCredential).toBe(true);
    expect(classifyBodyOnlyError({ nope: 1 })).toBeNull();
  });
});

describe('assertSafeUrlSync 同步校验臂', () => {
  it('http 非 https 拒绝（无 allowLocal）；内网 IP 拒绝；合法 https 放行', () => {
    expect(() => assertSafeUrlSync('http://example.com/x', { allowLocal: false })).toThrow();
    expect(() => assertSafeUrlSync('https://127.0.0.1/x', { allowLocal: false })).toThrow();
    expect(() => assertSafeUrlSync('https://169.254.1.1/x', { allowLocal: false })).toThrow();
    expect(assertSafeUrlSync('https://api.example.com/v1', { allowLocal: false })).toBeInstanceOf(URL);
    // 白名单语义见 assertSafeUrl（异步 DNS 后判定）；同步层无 allowedHosts 参数
  });
});
