/**
 * usage 侧深支矩阵（calibration / token-estimate / media-duration / normalize）：
 * 三层校准合并链、输入估算结构提取（媒体 part 全类型/循环引用 tools/embeddings 数组形态）、
 * 音频头部解析分支（WAV 块序/MP3 帧版本位）、usage 方言字符串数字。
 * 口径先读模块头注释：秒数向上取整、宁可高估不漏收、估算按未缓存计。
 */
import { describe, expect, it } from 'vitest';
import {
  resolveCalibration,
  DEFAULT_TOKEN_ESTIMATE_CALIBRATION,
} from '../src/usage/calibration.js';
import {
  estimateInputTokens,
  estimateOutputTokens,
  estimateUsage,
  extractTextFeatures,
} from '../src/usage/token-estimate.js';
import { estimateAudioDurationSeconds } from '../src/usage/media-duration.js';
import { normalizeUsage } from '../src/usage/normalize.js';

type Rec = Record<string, unknown>;

const wavTag = (t: string): Uint8Array => new TextEncoder().encode(t);

/** 手工构 WAV：RIFF/WAVE 头 + 任意块序列（pad = 奇数尺寸补零） */
const mkWav = (chunks: Array<{ id: string; body: Uint8Array; pad?: boolean }>): Uint8Array => {
  const parts: Uint8Array[] = [];
  parts.push(wavTag('RIFF'), new Uint8Array(4), wavTag('WAVE'));
  for (const c of chunks) {
    parts.push(wavTag(c.id));
    const sizeB = new Uint8Array(4);
    new DataView(sizeB.buffer).setUint32(0, c.body.length, true);
    parts.push(sizeB, c.body, ...(c.pad ? [new Uint8Array(1)] : [])); // 奇数尺寸补零（chunkSize%2 步进分支）
  }
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
};

// ─────────────────── calibration：三层合并链 ───────────────────

describe('calibration：三层合并（defaults ← provider ← provider:model）', () => {
  const calib = {
    defaults: { cjk: 0.7, word: 1.1, number: 1.0, symbol: 1.0 },
    tokensPerByte: 0.12,
    providers: {
      acme: { weights: { cjk: 0.5 }, templateInputOffset: 42, tokensPerByte: 0.2 },
    },
    models: {
      'acme:pro': { weights: { word: 2 }, templateInputOffset: 7, tokensPerByte: 0.05 },
      'acme:lite': { weights: { symbol: 0.1 } }, // 不带 offset/字节因子 → 继承 provider 层
    },
  };
  it('provider 层命中：weights 部分覆盖 + offset + 字节因子', () => {
    const c = resolveCalibration('acme', undefined, calib);
    expect(c).toEqual({
      weights: { cjk: 0.5, word: 1.1, number: 1.0, symbol: 1.0 },
      templateInputOffset: 42,
      tokensPerByte: 0.2,
    });
  });
  it('model 层全量覆盖（三者都换）', () => {
    const c = resolveCalibration('acme', 'pro', calib);
    expect(c).toEqual({
      weights: { cjk: 0.5, word: 2, number: 1.0, symbol: 1.0 },
      templateInputOffset: 7,
      tokensPerByte: 0.05,
    });
  });
  it('model 层部分覆盖 → 其余继承 provider 层', () => {
    const c = resolveCalibration('acme', 'lite', calib);
    expect(c.templateInputOffset).toBe(42);
    expect(c.tokensPerByte).toBe(0.2);
    expect(c.weights.symbol).toBe(0.1);
  });
  it('未命中保持默认；内置表 minimax:MiniMax-M3 字节因子生效', () => {
    expect(resolveCalibration('nope', 'nope', calib).tokensPerByte).toBe(0.12);
    expect(resolveCalibration('minimax', 'MiniMax-M3').tokensPerByte).toBe(0.03);
    expect(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.tokensPerByte).toBe(0.12);
  });
  it('estimateInputTokens 用内置表（无注入点）：默认层零偏移，估算=特征×默认权重', () => {
    // 内置表 providers 为空 → templateInputOffset 恒 0；此处锁「无 provider 时无偏移」
    const withProvider = estimateInputTokens(
      { messages: [{ role: 'user', content: 'hi' }] },
      { providerName: 'unknown' },
    );
    expect(withProvider).toBe(estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] }));
  });
});

// ─────────────────── token-estimate：结构提取分支 ───────────────────

describe('token-estimate：输入侧结构提取矩阵', () => {
  it('媒体 part 全类型枚举 → 每项保守下限 85', () => {
    const parts = [
      { type: 'image_url' },
      { type: 'image' },
      { type: 'input_image' },
      { type: 'audio' },
      { type: 'input_audio' },
      { type: 'video' },
      { type: 'file' },
      { image_url: { url: 'x' } },
      { input_image: 'y' },
      { input_audio: 'z' },
      { audio: 'w' },
    ];
    const n = estimateInputTokens({ messages: [{ role: 'user', content: parts }] });
    expect(n).toBeGreaterThanOrEqual(85 * parts.length);
  });
  it('content 数组垃圾容错：非对象 part / 既非文本也非媒体 → 不计', () => {
    expect(
      estimateInputTokens({ messages: [{ role: 'user', content: [7, { type: 'mystery' }] }] }),
    ).toBe(0);
    expect(estimateInputTokens({ messages: [{ role: 'user', content: 7 }] })).toBe(0); // 非字符串非数组
    expect(estimateInputTokens({ messages: [7] })).toBe(0); // 非对象消息
  });
  it('tool_calls：function 缺失/垃圾不计，name+arguments 拼接计数', () => {
    const withFn = estimateInputTokens({
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ function: { name: 'getweather', arguments: '{"city":"sf"}' } }],
        },
      ],
    });
    expect(withFn).toBeGreaterThan(0);
    expect(
      estimateInputTokens({ messages: [{ role: 'assistant', tool_calls: [7, { function: 7 }] }] }),
    ).toBe(0);
  });
  it('tools 循环引用 → JSON 序列化抛错被吞（不破坏估算）', () => {
    const tools: unknown[] = [{ type: 'function', function: { name: 'f' } }];
    (tools[0] as Record<string, unknown>).self = tools; // 循环引用
    const n = estimateInputTokens({ tools });
    expect(n).toBeGreaterThanOrEqual(0); // 跳过 tools 分量不抛
  });
  it('embeddings input 三形态：string / token-id 数组 / 嵌套 token-id 二维', () => {
    expect(estimateInputTokens({ input: 'ab' })).toBeGreaterThan(0);
    expect(estimateInputTokens({ input: [1, 2, 3] })).toBe(3);
    expect(estimateInputTokens({ input: [[1, 2], [3]] })).toBe(3);
    expect(estimateInputTokens({ input: [7] })).toBe(1); // 数字项即 token id（OpenAI 官方形态，任意数字都计 1）
    expect(estimateInputTokens({ input: 7 })).toBe(0); // 非字符串非数组
  });
  it('生成类端点顶层 prompt/query 计入（混合计价 token 分量）', () => {
    const both = estimateInputTokens({ prompt: 'a cat', query: 'dog' });
    expect(both).toBeGreaterThan(estimateInputTokens({ prompt: 'a cat' }));
    expect(estimateInputTokens({ prompt: 7, query: 7 })).toBe(0);
  });
});

describe('token-estimate：输出侧结构提取矩阵', () => {
  it('choices 垃圾容错与全量 choice 计数', () => {
    expect(estimateOutputTokens('x')).toBe(0);
    expect(estimateOutputTokens({ choices: 'x' })).toBe(0);
    expect(estimateOutputTokens({ choices: [7, { text: 'hi' }] })).toBeGreaterThan(0);
    const two = estimateOutputTokens({
      choices: [{ message: { content: 'aa' } }, { message: { content: 'aa' } }],
    });
    expect(two).toBe(2 * estimateOutputTokens({ choices: [{ message: { content: 'aa' } }] })); // n>1 全计（逐 choice 求和）
  });
  it('message 三种 reasoning 字段同口径 + content 数组/媒体下限', () => {
    const viaReasoning = estimateOutputTokens({ choices: [{ message: { reasoning: 'sample' } }] });
    const viaThinking = estimateOutputTokens({ choices: [{ message: { thinking: 'sample' } }] });
    const viaContent = estimateOutputTokens({ choices: [{ message: { content: 'sample' } }] });
    expect(viaReasoning).toBe(viaContent);
    expect(viaThinking).toBe(viaContent);
    expect(
      estimateOutputTokens({ choices: [{ message: { content: [{ type: 'image_url' }] } }] }),
    ).toBeGreaterThanOrEqual(85);
    expect(estimateOutputTokens({ choices: [{ message: null, text: 'txt' }] })).toBeGreaterThan(0); // message 缺失走 text
  });
  it('estimateUsage：estimated=true、cached=0（估算按未缓存口径）', () => {
    const u = estimateUsage(
      { messages: [{ role: 'user', content: 'hi' }] },
      { choices: [{ message: { content: 'yo' } }] },
    );
    expect(u.estimated).toBe(true);
    expect(u.cachedInputTokens).toBe(0);
    expect(u.inputTokens).toBeGreaterThan(0);
    expect(u.outputTokens).toBeGreaterThan(0);
  });
  it('extractTextFeatures：拉丁扩展/谚文/假名/扩展 B 分类', () => {
    const f = extractTextFeatures(' café 한국 ひら k');
    expect(f.cjkChars).toBe(4); // 2 谚文 + 2 假名（é 是拉丁扩展 → 词段）
    expect(f.wordSegments).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────── media-duration：头部解析分支 ───────────────────

describe('media-duration：WAV/MP3 头解析分支（秒数向上取整）', () => {
  it('data 块在 fmt 前：逐块遍历仍找到两者（else-if 分支 + 循环推进）', () => {
    const data = new Uint8Array(32_000); // 1s @ 32KB/s
    const fmt = new Uint8Array(16);
    const dv = new DataView(fmt.buffer);
    dv.setUint32(8, 32_000, true); // byteRate @ fmt+8（解析侧 offset+16）
    const sec = estimateAudioDurationSeconds(
      mkWav([
        { id: 'data', body: data },
        { id: 'fmt ', body: fmt },
      ]),
    );
    expect(sec).toBe(1);
  });
  it('奇数尺寸块的补零步进（chunkSize%2）', () => {
    const fmt = new Uint8Array(16);
    new DataView(fmt.buffer).setUint32(8, 16_000, true);
    const odd = new Uint8Array(3); // 奇数尺寸 + 未知 chunk id
    const data = new Uint8Array(16_000);
    const sec = estimateAudioDurationSeconds(
      mkWav([
        { id: 'junk', body: odd, pad: true },
        { id: 'fmt ', body: fmt },
        { id: 'data', body: data },
      ]),
    );
    expect(sec).toBe(1);
  });
  it('RIFF/WAVE 但缺 fmt 或 data → MP3 路径 → 16KB/s 兜底', () => {
    const junk = new Uint8Array(32_748); // 12(RIFF 头) + 8(chunk 头) + body = 32768B → 恰 2s
    junk.fill(0x01);
    const wav = mkWav([{ id: 'junk', body: junk }]);
    expect(estimateAudioDurationSeconds(wav)).toBe(2); // 32KB/16KB/s（含协议头的整文件口径）
  });
  it('MP3：保留版本位（01）跳过 + ID3 跳过后命中 MPEG2.5 低码率表', () => {
    const buf = new Uint8Array(2000);
    // ID3 头（tagSize=10）→ 音频起点 20
    buf.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a], 0);
    // 帧头 1：版本位 01（保留）→ continue 扫描
    buf.set([0xff, 0xe8, 0x00], 20);
    // 帧头 2：版本位 00（MPEG2.5）LayerIII、bitrateIndex=1 → table2 8kbps → 1000B/s
    buf.set([0xff, 0xe3, 0x10], 24);
    const sec = estimateAudioDurationSeconds(buf);
    expect(sec).toBe(2); // ceil((2000-20)/1000)
  });
  it('短于 16 字节 → 1 秒下限', () => {
    expect(estimateAudioDurationSeconds(new Uint8Array(8))).toBe(1);
  });

  it('B9 回归：伪造超大 byteRate 不可少计——字节率按 8MB/s 上界钳制', () => {
    const fmt = new Uint8Array(16);
    new DataView(fmt.buffer).setUint32(8, 0xffff_ffff, true); // 声明字节率 4GB/s（伪造）
    const data = new Uint8Array(10 * 1024 * 1024); // 实际 10MB 音频字节
    const sec = estimateAudioDurationSeconds(
      mkWav([
        { id: 'fmt ', body: fmt },
        { id: 'data', body: data },
      ]),
    );
    // = ceil(10MB ÷ 8MB/s) = 2s（旧实现按伪造头计 1s）
    expect(sec).toBe(2);
  });

  it('B9 回归：伪造微型 data chunkSize 不可少计——fileSize÷上界的文件级下界兜住', () => {
    const fmt = new Uint8Array(16);
    new DataView(fmt.buffer).setUint32(8, 32_000, true); // 字节率诚实 32KB/s
    const data = new Uint8Array(10 * 1024 * 1024); // 实际 10MB 音频字节
    const wav = mkWav([
      { id: 'fmt ', body: fmt },
      { id: 'data', body: data },
    ]);
    // data chunkSize 字段 @40（RIFF 12 + fmt 头 8 + fmt 体 16 + data id 4）篡改为 1
    new DataView(wav.buffer, wav.byteOffset).setUint32(40, 1, true);
    // 伪造声明只承认 1 字节（dataBytes 路径 1s）；文件级下界 ceil(10MB ÷ 8MB/s)
    // = 2s 兜底（旧实现无两道防线 → 1s 少计；诚实计费应 ~320s）
    expect(estimateAudioDurationSeconds(wav)).toBe(2);
  });

  it('B9 回归：MP3 多帧取中位位率（伪造首帧高码率声明不放大少计）', () => {
    const buf = new Uint8Array(200_000);
    buf.set([0xff, 0xfb, 0xd0], 0); // 首帧声明 320kbps（伪造）
    for (let j = 0; j < 4; j++) buf.set([0xff, 0xfb, 0x50], 10 + j * 10); // 64kbps × 4
    const sec = estimateAudioDurationSeconds(buf);
    // 中位 = 64kbps → 8000B/s → 25s；按首帧 320 则 5s（少计 5 倍）
    expect(sec).toBe(25);
  });
});

// ─────────────────── normalize：方言矩阵 ───────────────────

describe('normalizeUsage：方言与字符串数字矩阵', () => {
  it('字符串数字：合法十进制串采信；前导零/负数/浮点拒收', () => {
    expect(normalizeUsage({ prompt_tokens: '10', completion_tokens: 2 })).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(normalizeUsage({ prompt_tokens: '010', completion_tokens: 1 })).toBeNull();
    expect(normalizeUsage({ prompt_tokens: '-1', completion_tokens: 1 })).toBeNull();
    expect(normalizeUsage({ prompt_tokens: '1.5', completion_tokens: 1 })).toBeNull();
    expect(normalizeUsage({ prompt_tokens: 1.5, completion_tokens: 1 })).toBeNull(); // 非安全整数
  });
  it('input_tokens 变体与冲突弃真', () => {
    expect(normalizeUsage({ input_tokens: 4, output_tokens: 2 })).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
    });
    expect(normalizeUsage({ prompt_tokens: 4, input_tokens: 5, output_tokens: 2 })).toBeNull(); // 冲突 → null
    expect(
      normalizeUsage({ prompt_tokens: 4, input_tokens: 4, completion_tokens: 2, output_tokens: 3 }),
    ).toBeNull();
  });
  it('DeepSeek：只有 miss（无 hit）→ cached 0、输入按 hit+miss 重建', () => {
    expect(
      normalizeUsage({ prompt_tokens: 7, completion_tokens: 1, prompt_cache_miss_tokens: 7 }),
    ).toMatchObject({ inputTokens: 7, cachedInputTokens: 0 });
    // 重建值与显式 prompt_tokens 冲突 → 弃真
    expect(
      normalizeUsage({ prompt_tokens: 8, completion_tokens: 1, prompt_cache_miss_tokens: 7 }),
    ).toBeNull();
  });
  it('Mistral camel 变体：promptTokensDetails/numCachedTokens 及其冲突', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 5,
        completion_tokens: 1,
        promptTokensDetails: { cachedTokens: 2 },
      }),
    ).toMatchObject({ cachedInputTokens: 2 });
    expect(
      normalizeUsage({ prompt_tokens: 5, completion_tokens: 1, numCachedTokens: 2 }),
    ).toMatchObject({ cachedInputTokens: 2 });
    expect(
      normalizeUsage({
        prompt_tokens: 5,
        completion_tokens: 1,
        numCachedTokens: 2,
        num_cached_tokens: 3,
      }),
    ).toBeNull();
    expect(
      normalizeUsage({
        prompt_tokens: 5,
        completion_tokens: 1,
        promptTokensDetails: { cachedTokens: 2 },
        promptTokenDetails: { cachedTokens: 2 },
      }),
    ).toMatchObject({ cachedInputTokens: 2 });
    expect(
      normalizeUsage({
        prompt_tokens: 5,
        completion_tokens: 1,
        promptTokensDetails: { cachedTokens: 2 },
        promptTokenDetails: { cachedTokens: 9 },
      }),
    ).toBeNull();
  });
  it('details snake 变体冲突弃真；cache_write 0 不造键', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 6,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 2 },
        input_tokens_details: { cached_tokens: 9 },
      }),
    ).toBeNull();
    const u = normalizeUsage({ prompt_tokens: 6, completion_tokens: 1, cache_write_tokens: 0 });
    expect((u as unknown as Rec).cacheWriteTokens).toBeUndefined();
  });
  it('output 缺省归 0；total 一致通过', () => {
    expect(normalizeUsage({ prompt_tokens: 3 })).toMatchObject({ inputTokens: 3, outputTokens: 0 });
    expect(
      normalizeUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
    ).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });
});
