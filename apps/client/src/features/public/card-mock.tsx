'use client';

import { Gauge, KeyRound, Sparkles, Wallet } from 'lucide-react';

import type { CarouselCard } from './hero-carousel-shared';

/** 卡片内的白色悬浮 mock */
export function CardMock({ card }: { card: CarouselCard }) {
  if (card.theme === 'models') {
    return (
      <div className="w-[min(400px,78%)] rounded-2xl border border-black/5 bg-white p-5 shadow-[0_24px_64px_rgba(15,23,42,0.18)]">
        <div className="mb-4 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <Sparkles className="size-3.5 text-[#3957ff]" />
            {card.featuredLabel}
          </span>
        </div>
        <ul className="space-y-2">
          {(card.models ?? []).map((m, i) => (
            <li
              key={`${m.name}-${i}`}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-[#3957ff] to-[#7c3aed] text-xs font-bold text-white">
                {m.name.slice(0, 1)}
              </span>
              <span className="flex-1 truncate font-mono text-[13px] font-medium text-slate-800">
                {m.name}
              </span>
              <span className="text-[11px] text-slate-400">{m.contextLabel}</span>
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                {card.freeChip}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (card.theme === 'api') {
    return (
      <div className="w-[min(520px,80%)] overflow-hidden rounded-2xl border border-white/10 bg-[#0f1524] shadow-[0_24px_64px_rgba(15,23,42,0.5)]">
        <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-3 flex items-center gap-1.5 text-xs text-slate-400">
            <KeyRound className="size-3.5" /> {card.host}
          </span>
        </div>
        <pre className="overflow-x-auto p-5 text-left font-mono text-[12.5px]">
          <code>
            <span className="text-[#7aa2ff]">POST</span>{' '}
            <span className="text-slate-300">/v1/chat/completions</span>
            {'\n'}
            <span className="text-slate-400">Authorization:</span>{' '}
            <span className="text-emerald-400">Bearer ag-****</span>
            {'\n\n'}
            <span className="text-slate-400">{'{'}</span>
            {'\n  '}
            <span className="text-[#7aa2ff]">"model"</span>
            <span className="text-slate-400">:</span>{' '}
            <span className="text-emerald-400">"deepseek-chat"</span>
            <span className="text-slate-400">,</span>
            {'\n  '}
            <span className="text-[#7aa2ff]">"stream"</span>
            <span className="text-slate-400">:</span> <span className="text-amber-400">true</span>
            <span className="text-slate-400">,</span>
            {'\n  '}
            <span className="text-[#7aa2ff]">"messages"</span>
            <span className="text-slate-400">:</span> <span className="text-slate-400">[…]</span>
            {'\n'}
            <span className="text-slate-400">{'}'}</span>
          </code>
        </pre>
      </div>
    );
  }

  if (card.theme === 'usage') {
    const points = [4, 12, 7, 18, 10, 24, 14, 20, 9, 22, 16, 26];
    const ratio = 260 / points.length;
    const path = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * ratio).toFixed(1)},${40 - p}`)
      .join(' ');
    return (
      <div className="w-[min(400px,78%)] rounded-2xl border border-black/5 bg-white p-5 shadow-[0_24px_64px_rgba(15,23,42,0.18)]">
        <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-slate-500">
          <Gauge className="size-3.5 text-[#7c3aed]" />
          {card.exampleLabel}
        </p>
        <div className="grid grid-cols-2 gap-3">
          {(card.stats ?? []).map((s) => (
            <div key={s.label} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
              <p className="text-xs text-slate-400">{s.label}</p>
              <p className="mt-1 text-xl font-bold tracking-tight text-slate-900">{s.value}</p>
            </div>
          ))}
        </div>
        <svg viewBox="0 0 260 42" className="mt-4 w-full" aria-hidden>
          <path d={path} fill="none" stroke="#7c3aed" strokeWidth="1.6" strokeLinecap="round" />
          <path d={`${path} L260,42 L0,42 Z`} fill="url(#grad-usage)" stroke="none" />
          <defs>
            <linearGradient id="grad-usage" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </div>
    );
  }

  // wallet
  const [balance, ...rows] = card.stats ?? [];
  return (
    <div className="w-[min(400px,78%)] rounded-2xl border border-black/5 bg-white p-5 shadow-[0_24px_64px_rgba(15,23,42,0.18)]">
      <p className="text-xs text-slate-400">{balance?.label}</p>
      <p className="mt-1 text-xl font-bold tracking-tight text-slate-900">{balance?.value}</p>
      <div className="mt-4 space-y-2">
        {rows.map((s) => (
          <div
            key={s.label}
            className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-[13px]"
          >
            <span className="flex items-center gap-2 text-slate-600">
              <Wallet className="size-3.5 text-[#f59e0b]" />
              {s.label}
            </span>
            <span className="font-medium text-slate-900">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
