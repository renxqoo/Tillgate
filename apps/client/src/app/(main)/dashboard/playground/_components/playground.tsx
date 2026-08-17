'use client';

import { useRef, useState } from 'react';
import { SendIcon } from 'lucide-react';

import { Button } from '@ai-gateway/ui/components/ui/button';
import { Card, CardContent } from '@ai-gateway/ui/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ai-gateway/ui/components/ui/select';
import { Textarea } from '@ai-gateway/ui/components/ui/textarea';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

export function Playground({ models }: { models: string[] }) {
  const [model, setModel] = useState(models[0] ?? '');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function send() {
    const text = input.trim();
    if (!text || !model || pending) return;
    setError(null);
    const next: Msg[] = [...messages, { role: 'user', content: text }, { role: 'assistant', content: '' }];
    setMessages(next);
    setInput('');
    setPending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/api/playground/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ model, stream: true, messages: next.slice(0, -1).map((m) => ({ role: m.role, content: m.content })) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `请求失败 (${res.status})`);
      }
      // fetch-stream 消费（SSE data 帧 → delta.content 增量渲染）
      const reader = res.body.getReader();
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
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              setMessages((cur) => {
                const copy = [...cur];
                copy[copy.length - 1] = { role: 'assistant', content: copy[copy.length - 1]!.content + delta };
                return copy;
              });
            }
          } catch {
            /* 非 JSON 帧忽略 */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {messages.length > 0 ? (
          <Button variant="outline" size="sm" onClick={() => setMessages([])}>
            清空
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="min-h-64 space-y-3 p-4">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">输入消息开始对话；输出按模型定价从余额扣费。</p>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                <div
                  className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    m.role === 'user' ? 'bg-primary/10' : 'bg-muted'
                  }`}
                >
                  {m.content || (pending && i === messages.length - 1 ? '…' : '')}
                </div>
              </div>
            ))
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
          placeholder="输入消息（Enter 发送 / Shift+Enter 换行）"
          rows={2}
        />
        {pending ? (
          <Button variant="outline" onClick={() => abortRef.current?.abort()}>
            停止
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
