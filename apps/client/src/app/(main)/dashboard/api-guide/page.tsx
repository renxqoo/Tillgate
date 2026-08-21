import { BookOpenTextIcon } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';

import { BaseUrlBadge } from './_components/base-url-badge';
import { CodeBlock } from './_components/code-block';

export const dynamic = 'force-dynamic';

/** 示例统一占位：部署域名与 Key（用户替换成自己的） */
const BASE = 'https://app.example.com/v1';
const KEY = 'sk-你的Key';

const QUICK_PY = `from openai import OpenAI

client = OpenAI(
    base_url="${BASE}",
    api_key="${KEY}",  # 在「API Key」页创建
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",  # 可用模型见下方「模型列表」
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)`;

const QUICK_CURL = `curl ${BASE}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}]
  }'`;

const STREAM_JS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE}', apiKey: '${KEY}' });

const stream = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '讲个笑话' }],
  stream: true, // SSE 流式：逐 token 返回
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}`;

const VISION_CURL = `curl ${BASE}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "这张图里有什么？"},
        {"type": "image_url", "image_url": {"url": "https://example.com/cat.png"}}
      ]
    }]
  }'`;

const IMAGES_CURL = `curl ${BASE}/images/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "qwen-image", "prompt": "一只戴墨镜的橘猫", "n": 1, "size": "1024x1024"}'`;

const TTS_CURL = `curl ${BASE}/audio/speech \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "tts-1", "input": "今天天气不错", "voice": "alloy"}' \\
  --output speech.mp3`;

const STT_CURL = `curl ${BASE}/audio/transcriptions \\
  -H "Authorization: Bearer ${KEY}" \\
  -F file=@ recording.mp3 \\
  -F model=whisper-1`;

const EMBED_CURL = `curl ${BASE}/embeddings \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "text-embedding-3-small", "input": "向量化这段文本"}'`;

const VIDEO_CURL = `# 1) 提交任务 → 201 返回任务 id
curl ${BASE}/video/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "video-01", "prompt": "一段海浪拍打沙滩的镜头"}'

# 2) 轮询任务状态（status: pending → processing → succeeded）
curl ${BASE}/videos/<任务id> -H "Authorization: Bearer ${KEY}"`;

const MUSIC_CURL = `curl ${BASE}/music/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "music-01", "prompt": "轻快的钢琴曲", "duration": 30}'`;

const CLAUDE_PY = `from anthropic import Anthropic

# Anthropic SDK 直连：网关兼容 /v1/messages 协议
client = Anthropic(base_url="${BASE}", api_key="${KEY}")

msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content[0].text)`;

const GEMINI_CURL = `curl "https://app.example.com/v1beta/models/gemini-2.5-flash:generateContent" \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"contents": [{"parts": [{"text": "你好"}]}]}'
# 流式：把 :generateContent 换成 :streamGenerateContent`;

const OAUTH_TOKEN = `curl -X POST ${BASE.replace('/v1', '')}/oauth/token \\
  -H "Content-Type: application/json" \\
  -d '{
    "grant_type": "client_credentials",
    "client_id": "你的应用ID",
    "client_secret": "你的应用Secret"
  }'
# → {"access_token": "<JWT>", "expires_in": ...}
# 调推理接口时改用：Authorization: Bearer <JWT>`;

const MODELS_CURL = `curl ${BASE}/models -H "Authorization: Bearer ${KEY}"`;

const ENDPOINTS: Array<{ method: string; path: string; kind: string; note: string }> = [
  {
    method: 'POST',
    path: '/v1/chat/completions',
    kind: '文本对话',
    note: '流式/非流式/多模态图片输入',
  },
  {
    method: 'POST',
    path: '/v1/images/generations',
    kind: '图像生成',
    note: '文生图，返回图片 URL/base64',
  },
  {
    method: 'POST',
    path: '/v1/audio/speech',
    kind: '语音合成',
    note: '文本转语音，返回音频二进制',
  },
  {
    method: 'POST',
    path: '/v1/audio/transcriptions',
    kind: '语音转写',
    note: 'multipart 上传音频文件',
  },
  {
    method: 'POST',
    path: '/v1/audio/translations',
    kind: '语音翻译',
    note: 'multipart 上传音频文件',
  },
  { method: 'POST', path: '/v1/images/edits', kind: '图像编辑', note: 'multipart 上传原图 + 指令' },
  { method: 'POST', path: '/v1/embeddings', kind: '向量化', note: '文本/Token 数组' },
  {
    method: 'POST',
    path: '/v1/video/generations',
    kind: '视频生成',
    note: '异步任务，GET /v1/videos/:id 轮询',
  },
  {
    method: 'POST',
    path: '/v1/music/generations',
    kind: '音乐生成',
    note: '异步任务，GET /v1/musics/:id 轮询',
  },
  { method: 'POST', path: '/v1/messages', kind: 'Anthropic 兼容', note: 'Claude 协议原样接入' },
  {
    method: 'POST',
    path: '/v1beta/models/:model:generateContent',
    kind: 'Gemini 原生',
    note: '含 :streamGenerateContent 流式',
  },
  { method: 'POST', path: '/v1/completions', kind: 'Legacy 补全', note: '旧版 completions 协议' },
  { method: 'POST', path: '/v1/responses', kind: 'Responses API', note: 'OpenAI Responses 协议' },
  { method: 'POST', path: '/v1/rerank', kind: '重排', note: '检索结果重排' },
  { method: 'GET', path: '/v1/models', kind: '模型列表', note: '当前 Key 可用的全部模型' },
  { method: 'POST', path: '/oauth/token', kind: '应用凭证', note: '企业 Agent 换短期 JWT' },
];

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {desc ? <CardDescription>{desc}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

export default function ApiGuidePage() {
  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BookOpenTextIcon className="size-5 text-muted-foreground" />
          接口调用
        </h1>
        <p className="text-sm text-muted-foreground">
          网关完全兼容 OpenAI 接口——现有 SDK 与代码只需改 Base URL 和 API Key。
        </p>
        <div className="pt-1">
          <BaseUrlBadge />
        </div>
      </div>

      <Section title="快速开始" desc="三步：创建 API Key → 替换 Base URL → 照常调用。">
        <CodeBlock code={QUICK_PY} lang="python (openai SDK)" />
        <CodeBlock code={QUICK_CURL} lang="curl" />
      </Section>

      <Section title="流式输出" desc="请求体加 stream: true，响应为 SSE——SDK 自动处理。">
        <CodeBlock code={STREAM_JS} lang="javascript (openai SDK)" />
      </Section>

      <Section
        title="多模态（图片输入）"
        desc="content 传数组，text 与 image_url 混排；本地图片可转 base64 data URL。"
      >
        <CodeBlock code={VISION_CURL} lang="curl" />
      </Section>

      <Section title="图像生成" desc="文生图；按产出张数计费，n 控制数量。">
        <CodeBlock code={IMAGES_CURL} lang="curl" />
      </Section>

      <Section title="音频" desc="语音合成（TTS）返回音频二进制；转写/翻译用 multipart 上传文件。">
        <CodeBlock code={TTS_CURL} lang="curl · 语音合成" />
        <CodeBlock code={STT_CURL} lang="curl · 语音转写" />
      </Section>

      <Section title="向量化（Embeddings）">
        <CodeBlock code={EMBED_CURL} lang="curl" />
      </Section>

      <Section
        title="视频 / 音乐生成"
        desc="异步任务：提交后拿任务 id，轮询到 succeeded 取产物；按秒/按件计费。"
      >
        <CodeBlock code={VIDEO_CURL} lang="curl · 视频" />
        <CodeBlock code={MUSIC_CURL} lang="curl · 音乐" />
      </Section>

      <Section
        title="Anthropic / Gemini 协议直连"
        desc="无需改代码结构——Anthropic SDK 直接指过来；Gemini 走原生路径。"
      >
        <CodeBlock code={CLAUDE_PY} lang="python (anthropic SDK)" />
        <CodeBlock code={GEMINI_CURL} lang="curl · gemini 原生" />
      </Section>

      <Section
        title="企业 Agent（应用凭证）"
        desc="在「应用」页创建应用获得 client_id/secret，换短期 JWT 调用——适合服务器端免存长期 Key。"
      >
        <CodeBlock code={OAUTH_TOKEN} lang="curl" />
      </Section>

      <Section
        title="端点速查表"
        desc="全部推理端点均需 Authorization: Bearer；错误响应为 OpenAI 风格 {error:{code,message}}。"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">方法</TableHead>
              <TableHead>路径</TableHead>
              <TableHead className="w-28">能力</TableHead>
              <TableHead className="hidden @xl/main:table-cell">说明</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENDPOINTS.map((ep) => (
              <TableRow key={ep.path + ep.method}>
                <TableCell className="font-mono text-xs">{ep.method}</TableCell>
                <TableCell className="font-mono text-xs">{ep.path}</TableCell>
                <TableCell className="text-xs">{ep.kind}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground @xl/main:table-cell">
                  {ep.note}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <CodeBlock code={MODELS_CURL} lang="curl · 查看可用模型" />
      </Section>
    </div>
  );
}
