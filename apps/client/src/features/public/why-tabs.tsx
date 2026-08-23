'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';

export interface WhyStat {
  value: string;
  label: string;
}

export interface WhyTabData {
  title: string;
  text: string;
  items: string[];
  stats: WhyStat[];
  ctaLabel: string;
  ctaHref: string;
}

interface Props {
  tabA: WhyTabData;
  tabB: WhyTabData;
  tabALabel: string;
  tabBLabel: string;
}

/** 个人开发 / 企业团队 双 Tab：左侧要点列表 + 右侧数据面板同屏切换 */
export function WhyTabs({ tabA, tabB, tabALabel, tabBLabel }: Props) {
  const [active, setActive] = useState<0 | 1>(0);
  const tab = active === 0 ? tabA : tabB;

  return (
    <div className="grid gap-10 lg:grid-cols-[5fr_7fr]">
      <div className="space-y-6">
        <div className="inline-flex rounded-xl bg-slate-100 p-1">
          <button
            type="button"
            className={`rounded-lg px-5 py-2 text-sm transition-colors ${
              active === 0
                ? 'bg-white font-medium text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
            onClick={() => setActive(0)}
          >
            {tabALabel}
          </button>
          <button
            type="button"
            className={`rounded-lg px-5 py-2 text-sm transition-colors ${
              active === 1
                ? 'bg-white font-medium text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
            onClick={() => setActive(1)}
          >
            {tabBLabel}
          </button>
        </div>
        <ul className="space-y-3">
          {tab.items.map((item) => (
            <li key={item} className="flex items-center gap-3 text-[15px] text-slate-700">
              <span
                className={`flex size-5 items-center justify-center rounded-full ${
                  active === 0
                    ? 'bg-[#3957ff]/10 text-[#3957ff]'
                    : 'bg-violet-500/10 text-violet-600'
                }`}
              >
                <Check className="size-3" />
              </span>
              {item}
            </li>
          ))}
        </ul>
        <a
          href={tab.ctaHref}
          className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-700"
        >
          {tab.ctaLabel}
        </a>
      </div>

      <div className="overflow-hidden rounded-3xl border border-slate-100 bg-[#f5f7fb]">
        <div className="flex items-center justify-between border-b border-slate-200/70 bg-[#eef2f8] px-8 py-5">
          <p className="text-lg font-semibold tracking-tight text-slate-900">{tab.title}</p>
          <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-400">
            {active === 0 ? 'FREE' : 'ORG'}
          </span>
        </div>
        <div className="space-y-4 p-8">
          <p className="text-[15px] leading-relaxed text-slate-500">{tab.text}</p>
          <div className="grid grid-cols-2 gap-4">
            {tab.stats.map((s) => (
              <div key={s.label} className="rounded-2xl bg-white p-5">
                <p className="text-3xl font-bold tracking-tight text-slate-900">{s.value}</p>
                <p className="mt-1 text-sm text-slate-400">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
