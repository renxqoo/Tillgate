/**
 * model-rewrite 单元分支（逐行状态机）：
 * 非法/无 model 载荷、嵌套 model 自愈回退、超行上限、CRLF、UTF-8 跨 chunk 劈开、flush 尾行。
 */
import { describe, expect, it } from 'vitest';
import { rewriteModelInDataLine, SseModelRewriter } from '../src/transport/model-rewrite.js';

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('rewriteModelInDataLine（单行替换的守卫分支）', () => {
  it('非 data 行 / [DONE] / 非 JSON / 数组 / 非字符串 model / 无 model → 原样', () => {
    expect(rewriteModelInDataLine(': comment', 'catalog')).toBe(': comment');
    expect(rewriteModelInDataLine('data: [DONE]', 'catalog')).toBe('data: [DONE]');
    expect(rewriteModelInDataLine('data: {oops', 'catalog')).toBe('data: {oops');
    expect(rewriteModelInDataLine('data: [1,2]', 'catalog')).toBe('data: [1,2]');
    expect(rewriteModelInDataLine('data: {"model":42}', 'catalog')).toBe('data: {"model":42}');
    expect(rewriteModelInDataLine('data: {"a":1}', 'catalog')).toBe('data: {"a":1}');
  });

  it('命中行只换 model 值;无空格与带空格键形都保形', () => {
    expect(rewriteModelInDataLine('data: {"model":"real","a":1}', 'catalog')).toBe(
      'data: {"model":"catalog","a":1}',
    );
    expect(rewriteModelInDataLine('data:{"model" : "real"}', 'catalog')).toBe(
      'data:{"model" : "catalog"}',
    );
  });

  it('嵌套 model 抢先命中 → 自愈回退原行（顶层 model 未变即不动任何字节）', () => {
    const line = 'data: {"wrap":{"model":"inner"},"model":"real"}';
    expect(rewriteModelInDataLine(line, 'catalog')).toBe(line);
  });

  it('model 值内含转义/引号的替换后仍合法 JSON', () => {
    expect(rewriteModelInDataLine('data: {"model":"a\\"b"}', 'cat')).toBe('data: {"model":"cat"}');
  });
});

describe('SseModelRewriter（逐行状态机）', () => {
  it('跨 chunk 的半截行补齐后替换;注释行与 DONE 原样;CRLF 保形', () => {
    const w = new SseModelRewriter('catalog');
    const a = w.push(new TextEncoder().encode('data: {"mo'));
    expect(a.byteLength).toBe(0); // 半截行不吐
    const b = w.push(new TextEncoder().encode('del":"real","x":1}\r\ndata: [DONE]\r\n'));
    expect(dec(b)).toBe('data: {"model":"catalog","x":1}\r\ndata: [DONE]\r\n');
  });

  it('UTF-8 多字节字符在 chunk 边界劈开仍整体解码', () => {
    const w = new SseModelRewriter('目录模型');
    const bytes = new TextEncoder().encode('data: {"model":"real","c":"你好"}\n');
    const split = 30; // 劈在多字节序列内部
    const out = [w.push(bytes.slice(0, split)), w.push(bytes.slice(split))].map(dec).join('');
    expect(out).toBe('data: {"model":"目录模型","c":"你好"}\n');
  });

  it('flush 处理无换行尾行(含 CR);空尾返回空', () => {
    const w = new SseModelRewriter('catalog');
    expect(dec(w.push(new TextEncoder().encode('data: {"model":"real"}\r')))).toBe('');
    expect(dec(w.flush())).toBe('data: {"model":"catalog"}');
    expect(w.flush().byteLength).toBe(0);
  });

  it('无换行的半截行超过 maxLineBytes 抛英文错误(内存上界)', () => {
    const w = new SseModelRewriter('catalog', 64);
    const big = new TextEncoder().encode(`data: {"model":"${'x'.repeat(200)}"}`);
    expect(() => w.push(big)).toThrow(/SSE line exceeds maximum of 64 bytes/);
  });
});
