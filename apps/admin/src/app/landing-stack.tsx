import type { getTranslations } from 'next-intl/server';

/** 技术架构区块（技术栈词条平铺） */
export function LandingStack({
  t,
  stack,
}: {
  t: Awaited<ReturnType<typeof getTranslations<'landing'>>>;
  stack: string[];
}) {
  return (
    <section id="stack" className="scroll-mt-16 border-t border-border/60 py-16 sm:py-20">
      <div className="mx-auto w-full max-w-6xl px-6">
        <div className="mb-8 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {t('stackEyebrow')}
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">{t('stackTitle')}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{t('stackDescription')}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {stack.map((item) => (
            <span
              key={item}
              className="rounded-full border border-border bg-muted px-4 py-1.5 text-sm text-muted-foreground"
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
