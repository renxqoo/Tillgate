/**
 * Claude 内容块映射族（codec 家族内容件——claude-chat 请求双向与 claude-stream
 * 共用的 part/block 转换单一实现；守卫三件套来自 claude-chat）。
 *
 * 方言矩阵：OpenAI 规范形 content part（text/image_url/input_audio）⇄ Claude
 * content block（text/image/audio）。入站归一为规范形（跨协议路由无损）；
 * 原生 claude 形态块出站透传（同协议往返不降级）；未知类型退空文本占位
 * （消息结构保留）。thinking 历史块不回放（Anthropic 自身要求）。
 * 远程媒体 URL 仅放行 http(s)（防 file:/内网 scheme 经网关中继给上游）。
 */
import { asArray, asJson, str, type Json } from './claude-chat';

/** 远程媒体 URL 白名单：仅 http(s) */
const isHttpUrl = (u: string): boolean => /^https?:\/\//i.test(u);

/** chat image_url part → claude image 块（data URL → base64 source；http(s) 远程 → url source） */
function imageUrlToClaudeBlock(p: Json): unknown {
  const url = str(asJson(p.image_url)?.url) ?? '';
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (isHttpUrl(url)) return { type: 'image', source: { type: 'url', url } };
  return { type: 'text', text: '' };
}

/** chat input_audio part → claude audio 块（media_type 补全 audio/ 前缀；缺 data 退空文本） */
function inputAudioToClaudeBlock(p: Json): unknown {
  const audio = asJson(p.input_audio);
  const data = str(audio?.data) ?? '';
  const format = str(audio?.format) ?? '';
  if (!data) return { type: 'text', text: '' };
  return {
    type: 'audio',
    source: {
      type: 'base64',
      media_type: format.startsWith('audio/') ? format : `audio/${format}`,
      data,
    },
  };
}

/** 单个 chat content part → claude 块（text/image_url/input_audio/原生透传，未知→空文本占位） */
function chatPartToClaudeBlock(p: Json): unknown {
  if (p.type === 'text' && typeof p.text === 'string') return { type: 'text', text: p.text };
  if (p.type === 'image_url') return imageUrlToClaudeBlock(p);
  if (p.type === 'input_audio') return inputAudioToClaudeBlock(p);
  // 原生 claude 形态透传（claude 原生入站归一后不会再出现原始形——透传兜底
  // 防御外部直构的规范形体；url 源音频无 OpenAI 规范形对应，也经此透传）
  if ((p.type === 'image' || p.type === 'audio') && asJson(p.source) != null) return p;
  return { type: 'text', text: '' };
}

/** chat message.content → claude content blocks */
export function chatContentToClaude(content: unknown): unknown[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return asArray(content).map((part) => {
    const p = asJson(part);
    return p == null ? { type: 'text', text: '' } : chatPartToClaudeBlock(p);
  });
}

/** claude image 块 → 规范形 image_url part（base64 源 → data URL；http(s) url 源原样） */
function claudeImageToChatPart(source: Json): Record<string, unknown> | null {
  if (source.type === 'base64') {
    const mediaType = str(source.media_type) ?? '';
    const data = str(source.data) ?? '';
    if (!data) return null;
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } };
  }
  const url = str(source.url) ?? '';
  if (source.type === 'url' && isHttpUrl(url)) {
    return { type: 'image_url', image_url: { url } };
  }
  return null;
}

/** claude audio 块 → 规范形 input_audio part（base64 源；url 源无对应返回 null 不入列） */
function claudeAudioToChatPart(block: Json): Record<string, unknown> | null {
  const src = asJson(block.source);
  const data = str(src?.data) ?? '';
  if (src?.type !== 'base64' || !data) return null;
  const mediaType = str(src.media_type) ?? '';
  return {
    type: 'input_audio',
    input_audio: { data, format: mediaType.replace(/^audio\//, '') || 'wav' },
  };
}

/**
 * claude content blocks → chat content（文本 join 为 string；含媒体/工具时用块数组）。
 * 媒体块归一为规范形（image_url / input_audio）——跨协议路由无损；thinking 历史块
 * 丢弃（Anthropic 自身要求 thinking 不回放进后续请求历史）；全部丢弃时退空字符串
 * （空 content 数组会被 openai 兼容上游 400）；tool 族块消息层已提取，残余原样
 * 保留（防御式）。
 */
export function claudeContentToChat(blocks: unknown): string | Array<Record<string, unknown>> {
  const arr = asArray(blocks);
  const out: Array<Record<string, unknown>> = [];
  let textOnly = true;
  for (const b of arr) {
    const block = asJson(b);
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      const source = asJson(block.source);
      const imagePart = source == null ? null : claudeImageToChatPart(source);
      if (imagePart != null) out.push(imagePart);
      textOnly = false;
      continue;
    }
    if (block.type === 'audio') {
      const audioPart = claudeAudioToChatPart(block);
      if (audioPart != null) out.push(audioPart);
      textOnly = false;
      continue;
    }
    if (block.type === 'tool_use' || block.type === 'tool_result') {
      textOnly = false;
      out.push(block as Record<string, unknown>);
      continue;
    }
    if (block.type === 'thinking') {
      textOnly = false; // 历史思考不回放（不入列）
      continue;
    }
    textOnly = false;
  }
  if (textOnly) return out.map((b) => (b as { text: string }).text).join('');
  if (out.length === 0) return '';
  return out;
}
