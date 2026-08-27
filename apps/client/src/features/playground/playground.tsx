'use client';

import { useRef, useState } from 'react';
import { SendIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, Card, CardContent, Textarea } from '@tillgate/ui';

import { PlaygroundToolbar } from './playground-toolbar';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

/** 操练场 BYOK：用户自持 API Key 直连同域网关（Key 仅存本会话，不经服务端保存） */
const KEY_STORAGE = 'pg:api-key';

/** 单个 SSE 行 → delta.content；非 data 帧/[DONE]/非 JSON 帧一律返回 ''（忽略） */
function parseSseDelta(line: string): string {
  if (!line.startsWith('data: ')) return '';
  const payload = line.slice(6);
  if (payload === '[DONE]') return '';
  try {
    const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
    return chunk.choices?.[0]?.delta?.content ?? '';
  } catch {
    return '';
  }
}

/** fetch-stream 消费（SSE data 帧 → delta.content 增量回调；模块级压平 send 的复杂度/嵌套） */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const delta = parseSseDelta(line);
      if (delta !== '') onDelta(delta);
    }
  }
}

/** 消息气泡渲染（模块级渲染函数：压平组件行数，key 一并固定在此） */
function renderMessageBubble(m: Msg, i: number, ctx: { pending: boolean; total: number }) {
  return (
    <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
      <div
        className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          m.role === 'user' ? 'bg-primary/10' : 'bg-muted'
        }`}
      >
        {m.content || (ctx.pending && i === ctx.total - 1 ? '…' : '')}
      </div>
    </div>
  );
}

export function Playground({ models }: { models: string[] }) {
  const t = useTranslations('playground');
  const [model, setModel] = useState(models[0] ?? '');
  const [apiKey, setApiKey] = useState<string>(() => {
    try {
      return sessionStorage.getItem(KEY_STORAGE) ?? '';
    } catch {
      return '';
    }
  });
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  // 状态命名 sendError：让 send 内 catch 形参可按 catch-error-name 规则命名为 error 而不遮蔽
  const [sendError, setSendError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function onKeyChange(value: string): void {
    setApiKey(value);
    try {
      sessionStorage.setItem(KEY_STORAGE, value);
    } catch {
      /* 隐私模式等场景静默 */
    }
  }

  async function send() {
    const text = input.trim();
    const key = apiKey.trim();
    if (!text || !model || pending) return;
    if (!key.startsWith('sk_')) {
      setSendError(t('keyMissing'));
      return;
    }
    setSendError(null);
    const next: Msg[] = [
      ...messages,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ];
    setMessages(next);
    setInput('');
    setPending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          messages: next.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? t('requestFailed', { status: res.status }));
      }
      // SSE 增量写入最后一条 assistant 消息（at(-1) 判空守卫替代非空断言）
      await consumeSseStream(res.body, (delta) => {
        setMessages((cur) => {
          const copy = [...cur];
          const last = copy.at(-1);
          if (last === undefined) return cur;
          copy[copy.length - 1] = { role: 'assistant', content: last.content + delta };
          return copy;
        });
      });
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setSendError((error as Error).message);
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="space-y-4">
      <PlaygroundToolbar
        apiKey={apiKey}
        onKeyChange={onKeyChange}
        model={model}
        onModelChange={(v) => {
          if (typeof v === 'string' && v !== '') setModel(v);
        }}
        models={models}
        hasMessages={messages.length > 0}
        onClear={() => setMessages([])}
      />

      <Card>
        <CardContent className="min-h-64 space-y-3 p-4">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
          ) : (
            messages.map((m, i) => renderMessageBubble(m, i, { pending, total: messages.length }))
          )}
          {sendError ? <p className="text-sm text-destructive">{sendError}</p> : null}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={t('inputPlaceholder')}
          rows={2}
        />
        {pending ? (
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            {t('stop')}
          </Button>
        ) : (
          <Button onClick={send} disabled={!input.trim() || !model}>
            <SendIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
