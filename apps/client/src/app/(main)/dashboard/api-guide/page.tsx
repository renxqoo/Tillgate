import { BookOpenTextIcon } from 'lucide-react';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tokenlens/ui';

import { BaseUrlBadge } from '@/features/public/base-url-badge';
import { CodeBlock } from '@/features/public/code-block';
import { highlight } from '@/features/public/highlight';

export const dynamic = 'force-dynamic';

/** 端点速查表：kind/note 存 apiGuide.endpoints.{id} 目录键 */
const ENDPOINTS: Array<{ method: string; path: string; id: string }> = [
  { method: 'POST', path: '/v1/chat/completions', id: 'chat' },
  { method: 'POST', path: '/v1/images/generations', id: 'imagesGen' },
  { method: 'POST', path: '/v1/audio/speech', id: 'tts' },
  { method: 'POST', path: '/v1/audio/transcriptions', id: 'stt' },
  { method: 'POST', path: '/v1/audio/translations', id: 'translate' },
  { method: 'POST', path: '/v1/images/edits', id: 'imageEdit' },
  { method: 'POST', path: '/v1/embeddings', id: 'embeddings' },
  { method: 'POST', path: '/v1/video/generations', id: 'video' },
  { method: 'POST', path: '/v1/music/generations', id: 'music' },
  { method: 'POST', path: '/v1/messages', id: 'anthropic' },
  { method: 'POST', path: '/v1beta/models/:model:generateContent', id: 'gemini' },
  { method: 'POST', path: '/v1/completions', id: 'completions' },
  { method: 'POST', path: '/v1/responses', id: 'responses' },
  { method: 'POST', path: '/v1/rerank', id: 'rerank' },
  { method: 'GET', path: '/v1/models', id: 'models' },
  { method: 'POST', path: '/oauth/token', id: 'oauth' },
];

/** 服务端高亮包装：原始 code 供复制，shiki html 供展示 */
async function CodeSample({ code, lang }: { code: string; lang?: string }) {
  const html = await highlight(code, lang);
  return <CodeBlock lang={lang} html={html} text={code} />;
}

/** 当前部署的站点地址（示例与徽章同源，复制即用）：反代场景取 x-forwarded-host */
function siteOrigin(h: Headers): string {
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3001';
  const proto =
    h.get('x-forwarded-proto') ??
    (/^(localhost|127\.|192\.168\.|10\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

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

export default async function ApiGuidePage() {
  const t = await getTranslations('apiGuide');
  // 示例统一使用当前部署的真实地址（与 BaseUrlBadge 同源）——复制即可用，无需改域名
  const origin = siteOrigin(await headers());
  const BASE = `${origin}/v1`;
  const KEY = t('sampleKey');
  const APP_ID = t('sampleAppId');
  const APP_SECRET = t('sampleAppSecret');

  const QUICK_PY = `from openai import OpenAI

client = OpenAI(
    base_url="${BASE}",
    api_key="${KEY}",  # ${t('cKeyComment')}
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",  # ${t('cModelsComment')}
    messages=[{"role": "user", "content": "${t('cHello')}"}],
)
print(resp.choices[0].message.content)`;

  const QUICK_CURL = `curl ${BASE}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "${t('cHello')}"}]
  }'`;

  const STREAM_JS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE}', apiKey: '${KEY}' });

const stream = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '${t('cJoke')}' }],
  stream: true, // ${t('cSseComment')}
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
        {"type": "text", "text": "${t('cWhatsInImage')}"},
        {"type": "image_url", "image_url": {"url": "https://example.com/cat.png"}}
      ]
    }]
  }'`;

  const IMAGES_CURL = `curl ${BASE}/images/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "qwen-image", "prompt": "${t('cCatPrompt')}", "n": 1, "size": "1024x1024"}'`;

  const TTS_CURL = `curl ${BASE}/audio/speech \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "tts-1", "input": "${t('cWeather')}", "voice": "alloy"}' \\
  --output speech.mp3`;

  const STT_CURL = `curl ${BASE}/audio/transcriptions \\
  -H "Authorization: Bearer ${KEY}" \\
  -F file=@ recording.mp3 \\
  -F model=whisper-1`;

  const EMBED_CURL = `curl ${BASE}/embeddings \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "text-embedding-3-small", "input": "${t('cEmbedText')}"}'`;

  const VIDEO_CURL = `# ${t('cVideoStep1')}
curl ${BASE}/video/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "video-01", "prompt": "${t('cWavePrompt')}"}'

# ${t('cVideoStep2')}
curl ${BASE}/videos/${t('cTaskId')} -H "Authorization: Bearer ${KEY}"`;

  const MUSIC_CURL = `curl ${BASE}/music/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "music-01", "prompt": "${t('cPianoPrompt')}", "duration": 30}'`;

  const CLAUDE_PY = `from anthropic import Anthropic

# ${t('cAnthropicComment')}
client = Anthropic(base_url="${BASE}", api_key="${KEY}")

msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "${t('cHello')}"}],
)
print(msg.content[0].text)`;

  const GEMINI_CURL = `curl "${origin}/v1beta/models/gemini-2.5-flash:generateContent" \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"contents": [{"parts": [{"text": "${t('cHello')}"}]}]}'
# ${t('cGeminiStreamComment')}`;

  const OAUTH_TOKEN = `curl -X POST ${origin}/oauth/token \\
  -H "Content-Type: application/json" \\
  -d '{
    "grant_type": "client_credentials",
    "client_id": "${APP_ID}",
    "client_secret": "${APP_SECRET}"
  }'
# → {"access_token": "<JWT>", "expires_in": ...}
# ${t('cJwtComment')}`;

  const MODELS_CURL = `curl ${BASE}/models -H "Authorization: Bearer ${KEY}"`;

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BookOpenTextIcon className="size-5 text-muted-foreground" />
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <div className="pt-1">
          <BaseUrlBadge base={BASE} />
        </div>
      </div>

      <Section title={t('quickStartTitle')} desc={t('quickStartDesc')}>
        <CodeSample code={QUICK_PY} lang="python (openai SDK)" />
        <CodeSample code={QUICK_CURL} lang="curl" />
      </Section>

      <Section title={t('streamTitle')} desc={t('streamDesc')}>
        <CodeSample code={STREAM_JS} lang="javascript (openai SDK)" />
      </Section>

      <Section title={t('visionTitle')} desc={t('visionDesc')}>
        <CodeSample code={VISION_CURL} lang="curl" />
      </Section>

      <Section title={t('imagesTitle')} desc={t('imagesDesc')}>
        <CodeSample code={IMAGES_CURL} lang="curl" />
      </Section>

      <Section title={t('audioTitle')} desc={t('audioDesc')}>
        <CodeSample code={TTS_CURL} lang={t('langTts')} />
        <CodeSample code={STT_CURL} lang={t('langStt')} />
      </Section>

      <Section title={t('embedTitle')}>
        <CodeSample code={EMBED_CURL} lang="curl" />
      </Section>

      <Section title={t('avTitle')} desc={t('avDesc')}>
        <CodeSample code={VIDEO_CURL} lang={t('langVideo')} />
        <CodeSample code={MUSIC_CURL} lang={t('langMusic')} />
      </Section>

      <Section title={t('directTitle')} desc={t('directDesc')}>
        <CodeSample code={CLAUDE_PY} lang="python (anthropic SDK)" />
        <CodeSample code={GEMINI_CURL} lang={t('langGemini')} />
      </Section>

      <Section title={t('agentTitle')} desc={t('agentDesc')}>
        <CodeSample code={OAUTH_TOKEN} lang="curl" />
      </Section>

      <Section title={t('modelsTitle')} desc={t('modelsDesc')}>
        <CodeSample code={MODELS_CURL} lang="curl" />
      </Section>

      <Section title={t('tableTitle')} desc={t('tableDesc')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">{t('colMethod')}</TableHead>
              <TableHead>{t('colPath')}</TableHead>
              <TableHead className="w-28">{t('colCapability')}</TableHead>
              <TableHead className="hidden @xl/main:table-cell">{t('colNote')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENDPOINTS.map((ep) => (
              <TableRow key={ep.path + ep.method}>
                <TableCell className="font-mono text-xs">{ep.method}</TableCell>
                <TableCell className="font-mono text-xs">{ep.path}</TableCell>
                <TableCell className="text-xs">{t(`endpoints.${ep.id}.kind`)}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground @xl/main:table-cell">
                  {t(`endpoints.${ep.id}.note`)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}
