/**
 * 营销首页 · 免费模型榜单（等价 SkillHunt）+ 接入指南（等价 Plugin 广场）。
 * 榜单数据来自 /v1/pricing?free=true；示例代码使用真实部署 Base URL。
 */
import Link from 'next/link';
import { Terminal } from 'lucide-react';

import { CopyPill } from '@/features/public/copy-pill';

import { buildSamples } from './samples';
import type { LandingT } from './ui';

export { ModelsBoard } from './models-board';

export function GuideSection({ t, base }: { t: LandingT; base: string }) {
  const s = buildSamples(t, base);
  const samples = [
    { lang: t('guidePython'), badge: 'openai · v1', code: s.py },
    { lang: t('guideNode'), badge: 'openai · v4', code: s.node },
    { lang: t('guideCurl'), badge: 'REST', code: s.curl },
  ];

  return (
    <section id="guide" className="scroll-mt-20 py-20">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2">
        <div>
          <span className="inline-block rounded-full bg-[#3957ff]/10 px-3 py-1 text-xs font-medium text-[#3957ff]">
            {t('navGuide')}
          </span>
          <h2 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
            {t('guideTitle')}
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-slate-500">{t('guideSub')}</p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <CopyPill
              value={s.curl}
              label={t('guideCopyCmd')}
              copiedLabel={t('copiedBaseUrl')}
              className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            />
            <Link
              href="/dashboard/api-guide"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 transition-colors hover:text-slate-900"
            >
              <Terminal className="size-4" />
              {t('guideBrowse')} →
            </Link>
          </div>
        </div>
        <div className="space-y-4 rounded-3xl bg-[#f5f7fb] p-8">
          {samples.map((sm) => (
            <div key={sm.lang} className="rounded-2xl border border-slate-100 bg-white p-5">
              <div className="mb-3 flex items-center gap-2">
                <span className="size-2 rounded-full bg-[#3957ff]" />
                <span className="text-sm font-medium text-slate-900">{sm.lang}</span>
                <span className="ml-auto text-[11px] text-slate-300">{sm.badge}</span>
              </div>
              <pre className="overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed text-slate-600">
                {sm.code}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
