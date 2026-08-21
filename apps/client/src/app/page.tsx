import Link from "next/link";

import {
  ArrowRight,
  BadgeCheck,
  ChevronRight,
  CpuIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayersIcon,
  PlayIcon,
  RepeatIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  WalletIcon,
} from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { getMe } from "@ai-gateway/api-client";
import { getTranslations } from "next-intl/server";

import { APP_CONFIG } from "@/config/app-config";
import { fetchPublicPricing } from "@/lib/public-pricing";

export const dynamic = "force-dynamic";

/** 数字价展示：元/百万 Token 口径 */
function fmtPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `¥${String(Number(n.toFixed(4)))}`;
}

/** 计价方式目录键（pricing 命名空间）；未知 unit 原样回显 */
const PRICING_UNIT_KEYS: Record<string, string> = {
  token: "unitToken",
  request: "unitRequest",
  image: "unitImage",
  second: "unitSecond",
  char: "unitChar",
};

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <span className="h-px w-8 bg-border" aria-hidden />
      <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{children}</span>
      <span className="h-px w-8 bg-border" aria-hidden />
    </div>
  );
}

function SectionHeading({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="mx-auto mb-10 space-y-3 text-center">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="text-2xl font-bold tracking-tight md:text-3xl">{title}</h2>
      <p className="mx-auto max-w-2xl text-sm text-muted-foreground md:text-base">{sub}</p>
    </div>
  );
}

/** Hero 右侧：终端请求卡 + 悬浮能力徽章 */
function HeroVisual({ badgeStream, badgeFailover, badgeLedger }: { badgeStream: string; badgeFailover: string; badgeLedger: string }) {
  return (
    <div className="relative hidden lg:block">
      <div className="absolute -top-8 -right-6 size-48 rounded-full bg-primary/15 blur-3xl" aria-hidden />
      <div className="absolute -bottom-10 -left-10 size-56 rounded-full bg-sky-500/10 blur-3xl" aria-hidden />
      <div className="relative overflow-hidden rounded-xl border bg-card shadow-lg">
        <div className="flex items-center gap-1.5 border-b bg-muted/50 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-red-400/80" />
          <span className="size-2.5 rounded-full bg-yellow-400/80" />
          <span className="size-2.5 rounded-full bg-green-500/80" />
          <span className="ml-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <TerminalIcon className="size-3.5" /> api.ai-gateway.local
          </span>
        </div>
        <pre className="overflow-x-auto p-5 text-left text-[13px] leading-relaxed">
          <code>
            <span className="text-sky-600 dark:text-sky-400">POST</span>{" "}
            <span className="text-muted-foreground">/v1/chat/completions</span>
            {"\n"}
            <span className="text-muted-foreground">Authorization:</span>{" "}
            <span className="text-emerald-600 dark:text-emerald-400">Bearer ag-****</span>
            {"\n\n"}
            <span className="text-muted-foreground">{"{"}</span>
            {"\n  "}
            <span className="text-sky-600 dark:text-sky-400">&quot;model&quot;</span>
            <span className="text-muted-foreground">:</span>{" "}
            <span className="text-emerald-600 dark:text-emerald-400">&quot;RX-5.2&quot;</span>
            <span className="text-muted-foreground">,</span>
            {"\n  "}
            <span className="text-sky-600 dark:text-sky-400">&quot;stream&quot;</span>
            <span className="text-muted-foreground">:</span>{" "}
            <span className="text-amber-600 dark:text-amber-400">true</span>
            <span className="text-muted-foreground">,</span>
            {"\n  "}
            <span className="text-sky-600 dark:text-sky-400">&quot;messages&quot;</span>
            <span className="text-muted-foreground">:</span>{" "}
            <span className="text-muted-foreground">[…]</span>
            {"\n"}
            <span className="text-muted-foreground">{"}"}</span>
          </code>
        </pre>
      </div>
      <div className="absolute top-full mt-3 left-1/2 flex w-max max-w-full -translate-x-1/2 flex-wrap items-center justify-center gap-2">
        <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium shadow-md">
          <GaugeIcon className="size-3.5 text-primary" /> {badgeStream}
        </span>
        <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium shadow-md">
          <RepeatIcon className="size-3.5 text-primary" /> {badgeFailover}
        </span>
        <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium shadow-md">
          <ShieldCheckIcon className="size-3.5 text-primary" /> {badgeLedger}
        </span>
      </div>
    </div>
  );
}

/** 特性卡：icon + landing.features.{key} 目录文案 */
const FEATURES = [
  { icon: LayersIcon, key: "unified" },
  { icon: WalletIcon, key: "wallet" },
  { icon: RepeatIcon, key: "routing" },
  { icon: PlayIcon, key: "playground" },
  { icon: KeyRoundIcon, key: "keys" },
  { icon: CpuIcon, key: "reports" },
] as const;

const PROVIDER_KEYS = ["providerDeepSeek", "providerZhipu", "providerMiniMax", "providerOpenRouter", "providerOllama"] as const;

export default async function Landing() {
  const t = await getTranslations("landing");
  const tPricing = await getTranslations("pricing");
  // 模型广场：服务端只要免费前 9（免费徽章置前排；目录可达数千——不拉全量）
  const [me, freePage] = await Promise.all([
    getMe(),
    fetchPublicPricing({ free: true, pageSize: 9 }),
  ]);
  const showcase = freePage?.models ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <SparklesIcon className="size-4" />
            </span>
            {APP_CONFIG.name}
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#models" className="transition-colors hover:text-foreground">{t("navModels")}</a>
            <a href="#features" className="transition-colors hover:text-foreground">{t("navFeatures")}</a>
            <Link href="/pricing" className="transition-colors hover:text-foreground">{t("navPricing")}</Link>
          </nav>
          <div className="flex items-center gap-3">
            {me ? (
              <Button asChild size="sm" className="rounded-full">
                <Link href="/dashboard">
                  {t("enterConsole")} <ArrowRight />
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="outline" size="sm" className="rounded-full">
                  <Link href="/login">{t("login")}</Link>
                </Button>
                <Button asChild size="sm" className="rounded-full">
                  <Link href="/register">
                    {t("startFree")} <ArrowRight />
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-[size:28px_28px] opacity-60 [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)]"
            aria-hidden
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 md:py-28 lg:grid-cols-2">
            <div className="space-y-6">
              <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                <BadgeCheck className="size-3.5 text-primary" />
                {t("heroBadge")}
              </span>
              <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">
                {t("heroTitleLine1")}
                <br />
                {t("heroTitleLead")}<span className="text-primary">{t("heroTitleHighlight")}</span>
              </h1>
              <p className="max-w-lg text-base leading-relaxed text-muted-foreground">
                {t("heroDesc")}
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Button asChild size="lg" className="rounded-full">
                  <Link href={me ? "/dashboard" : "/register"}>
                    {me ? t("enterConsole") : t("startFree")} <ArrowRight />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg" className="rounded-full">
                  <Link href="/pricing">{t("viewPricing")}</Link>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("heroNote")}</p>
            </div>
            <HeroVisual
              badgeStream={t("badgeStream")}
              badgeFailover={t("badgeFailover")}
              badgeLedger={t("badgeLedger")}
            />
          </div>
        </section>

        {/* 供应商条 */}
        <section className="border-y bg-muted/30">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-6 text-sm font-medium text-muted-foreground">
            <span className="text-xs">{t("providersLabel")}</span>
            {PROVIDER_KEYS.map((key) => (
              <span key={key} className="transition-colors hover:text-foreground">{t(key)}</span>
            ))}
          </div>
        </section>

        {/* 模型广场 */}
        <section id="models" className="scroll-mt-16 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <SectionHeading
              eyebrow={t("modelsEyebrow")}
              title={t("modelsTitle")}
              sub={t("modelsSub")}
            />
            {showcase.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground">
                {t.rich("pricingUnavailable", {
                  link: (chunks) => (
                    <a className="underline" href="/pricing">{chunks}</a>
                  ),
                })}
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {showcase.map((m) => (
                  <div
                    key={m.id}
                    className="group relative flex flex-col rounded-xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                  >
                    {m.isFree ? (
                      <span className="absolute right-4 top-4 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        {t("freeBadge")}
                      </span>
                    ) : null}
                    <p className="mb-1 pr-14 font-mono text-sm font-semibold leading-snug">{m.externalName}</p>
                    <p className="mb-4 text-xs text-muted-foreground">
                      {(() => {
                        const unitKey = PRICING_UNIT_KEYS[m.pricingUnit];
                        return unitKey ? tPricing(unitKey) : m.pricingUnit;
                      })()}
                      {m.contextLength ? ` · ${t("contextShort", { n: Math.round(m.contextLength / 1000) })}` : ""}
                    </p>
                    <div className="mt-auto grid grid-cols-2 gap-2 border-t pt-3 text-xs text-muted-foreground">
                      <span>
                        {t("inputLabel")} <span className="font-medium text-foreground">{fmtPrice(m.inputPrice)}</span>
                      </span>
                      <span>
                        {t("outputLabel")} <span className="font-medium text-foreground">{fmtPrice(m.outputPrice)}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-8 text-center">
              <Button asChild variant="outline" className="rounded-full">
                <Link href="/pricing">
                  {t("viewAllModels")} <ChevronRight />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* 产品特性 */}
        <section id="features" className="scroll-mt-16 border-t bg-muted/30 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <SectionHeading
              eyebrow={t("featuresEyebrow")}
              title={t("featuresTitle")}
              sub={t("featuresSub")}
            />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div
                  key={f.key}
                  className="rounded-xl border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <span className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <f.icon className="size-5" />
                  </span>
                  <h3 className="mb-2 font-semibold">{t(`features.${f.key}.title`)}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t(`features.${f.key}.desc`)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="relative overflow-hidden rounded-2xl border bg-primary/5 px-6 py-14 text-center">
              <div className="pointer-events-none absolute -top-24 left-1/2 size-72 -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" aria-hidden />
              <h2 className="relative mb-3 text-2xl font-bold tracking-tight md:text-3xl">
                {t("ctaTitle")}
              </h2>
              <p className="relative mx-auto mb-8 max-w-xl text-sm text-muted-foreground md:text-base">
                {t("ctaDesc")}
              </p>
              <div className="relative flex flex-wrap items-center justify-center gap-4">
                <Button asChild size="lg" className="rounded-full">
                  <Link href={me ? "/dashboard" : "/register"}>
                    {me ? t("enterConsole") : t("registerNow")} <ArrowRight />
                  </Link>
                </Button>
                {me ? (
                  <Button asChild variant="outline" size="lg" className="rounded-full">
                    <Link href="/dashboard/playground">{t("tryPlayground")}</Link>
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="lg" className="rounded-full">
                    <Link href="/login">{t("hasAccountLogin")}</Link>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* 页脚 */}
      <footer className="border-t py-10">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 sm:grid-cols-3">
          <div>
            <div className="mb-3 flex items-center gap-2 font-semibold">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <SparklesIcon className="size-3" />
              </span>
              {APP_CONFIG.name}
            </div>
            <p className="text-sm text-muted-foreground">{t("footerTagline")}</p>
          </div>
          <div>
            <p className="mb-3 text-sm font-medium">{t("quickLinks")}</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/dashboard" className="hover:text-foreground">{t("enterConsole")}</Link></li>
              <li><Link href="/dashboard/playground" className="hover:text-foreground">{t("tryPlayground")}</Link></li>
              <li><Link href="/pricing" className="hover:text-foreground">{t("navPricing")}</Link></li>
            </ul>
          </div>
          <div>
            <p className="mb-3 text-sm font-medium">{t("developers")}</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/register" className="hover:text-foreground">{t("footerRegister")}</Link></li>
              <li><Link href="/login" className="hover:text-foreground">{t("login")}</Link></li>
              <li><Link href="/dashboard/keys" className="hover:text-foreground">{t("footerKeys")}</Link></li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-center text-xs text-muted-foreground">{APP_CONFIG.copyright}</p>
      </footer>
    </div>
  );
}
