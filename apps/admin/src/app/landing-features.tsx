import type { LucideIcon } from 'lucide-react';
import type { getTranslations } from 'next-intl/server';

/**
/** 产品能力区块（六卡平铺；t 经参数传入） */
export function LandingFeatures({
  t,
  features,
}: {
  t: Awaited<ReturnType<typeof getTranslations<'landing'>>>;
  features: Array<{ icon: LucideIcon; title: string; description: string }>;
}) {
  return (
    <section id="features" className="scroll-mt-16 border-t border-border/60 py-16 sm:py-20">
      <div className="mx-auto w-full max-w-6xl px-6">
        <div className="mb-12 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {t('featuresEyebrow')}
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">{t('featuresTitle')}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{t('featuresDescription')}</p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6 transition hover:border-foreground/20 hover:shadow-md"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon className="size-5" />
              </span>
              <h3 className="text-base font-semibold">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
