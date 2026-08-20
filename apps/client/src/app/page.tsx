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

import { APP_CONFIG } from "@/config/app-config";
import { fetchPublicPricing, PRICING_UNIT_LABEL } from "@/lib/public-pricing";

export const dynamic = "force-dynamic";

/** 数字价展示：元/百万 Token 口径 */
function fmtPrice(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return "—";
  return `¥${String(Number(n.toFixed(4)))}`;
}

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
function HeroVisual() {
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
          <GaugeIcon className="size-3.5 text-primary" /> 流式输出 · 首 token 秒回
        </span>
        <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium shadow-md">
          <RepeatIcon className="size-3.5 text-primary" /> 渠道容灾 · 自动切换
        </span>
        <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium shadow-md">
          <ShieldCheckIcon className="size-3.5 text-primary" /> 双分录账本 · 分毫不差
        </span>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    icon: LayersIcon,
    title: "OpenAI 协议统一",
    desc: "换个 base_url 即可接入——DeepSeek、GLM、MiniMax、OpenRouter 全部归一为 /v1/chat/completions，SDK 零改动。",
  },
  {
    icon: WalletIcon,
    title: "实时计费钱包",
    desc: "预扣 + 实扣两阶段记账，双分录账本每一分钱可对账；余额、账单、流水实时可见。",
  },
  {
    icon: RepeatIcon,
    title: "渠道容灾路由",
    desc: "多渠道按优先级加权路由，失败自动切换；渠道进货预算与熔断保护上游成本。",
  },
  {
    icon: PlayIcon,
    title: "免 Key 操练场",
    desc: "登录即可在控制台直接对话调试任意模型，按正常计费，流式输出所见即所得。",
  },
  {
    icon: KeyRoundIcon,
    title: "密钥与限额管理",
    desc: "独立 API Key 维度的 RPM/TPM 限流与日限额，封禁即全网失效，爆破自动锁定。",
  },
  {
    icon: CpuIcon,
    title: "用量报表",
    desc: "按模型、按 Key、按日的用量明细与费用统计，token 级账单随时回溯。",
  },
];

const PROVIDERS = ["DeepSeek", "智谱 GLM", "MiniMax", "OpenRouter", "Ollama"];

export default async function Landing() {
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
            <a href="#models" className="transition-colors hover:text-foreground">模型广场</a>
            <a href="#features" className="transition-colors hover:text-foreground">产品特性</a>
            <Link href="/pricing" className="transition-colors hover:text-foreground">模型定价</Link>
          </nav>
          <div className="flex items-center gap-3">
            {me ? (
              <Button asChild size="sm" className="rounded-full">
                <Link href="/dashboard">
                  进入控制台 <ArrowRight />
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild variant="outline" size="sm" className="rounded-full">
                  <Link href="/login">登录</Link>
                </Button>
                <Button asChild size="sm" className="rounded-full">
                  <Link href="/register">
                    免费开始 <ArrowRight />
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
                OpenAI 协议兼容 · 即插即用
              </span>
              <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">
                一个 API Key
                <br />
                直连<span className="text-primary">所有大模型</span>
              </h1>
              <p className="max-w-lg text-base leading-relaxed text-muted-foreground">
                统一接入 DeepSeek、智谱 GLM、MiniMax、OpenRouter 等主流模型——一个余额、一份账单、一套限额，
                开箱即用的 OpenAI 兼容网关。
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Button asChild size="lg" className="rounded-full">
                  <Link href={me ? "/dashboard" : "/register"}>
                    {me ? "进入控制台" : "免费开始"} <ArrowRight />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg" className="rounded-full">
                  <Link href="/pricing">查看模型定价</Link>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">注册即用，无需信用卡；免费模型零成本体验。</p>
            </div>
            <HeroVisual />
          </div>
        </section>

        {/* 供应商条 */}
        <section className="border-y bg-muted/30">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-6 text-sm font-medium text-muted-foreground">
            <span className="text-xs">已接入供应商</span>
            {PROVIDERS.map((p) => (
              <span key={p} className="transition-colors hover:text-foreground">{p}</span>
            ))}
          </div>
        </section>

        {/* 模型广场 */}
        <section id="models" className="scroll-mt-16 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <SectionHeading
              eyebrow="模型广场"
              title="一个账户，全模型可用"
              sub="对话、推理、多模态与生成任务模型持续上新；以下为实时定价的精选模型。"
            />
            {showcase.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground">
                定价服务暂不可用，请稍后再试或前往<a className="underline" href="/pricing">模型定价</a>查看。
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
                        免费
                      </span>
                    ) : null}
                    <p className="mb-1 pr-14 font-mono text-sm font-semibold leading-snug">{m.externalName}</p>
                    <p className="mb-4 text-xs text-muted-foreground">
                      {PRICING_UNIT_LABEL[m.pricingUnit] ?? m.pricingUnit}
                      {m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}K 上下文` : ""}
                    </p>
                    <div className="mt-auto grid grid-cols-2 gap-2 border-t pt-3 text-xs text-muted-foreground">
                      <span>
                        输入 <span className="font-medium text-foreground">{fmtPrice(m.inputPrice)}</span>
                      </span>
                      <span>
                        输出 <span className="font-medium text-foreground">{fmtPrice(m.outputPrice)}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-8 text-center">
              <Button asChild variant="outline" className="rounded-full">
                <Link href="/pricing">
                  查看全部模型 <ChevronRight />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* 产品特性 */}
        <section id="features" className="scroll-mt-16 border-t bg-muted/30 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <SectionHeading
              eyebrow="产品特性"
              title="为生产环境而生的网关"
              sub="从鉴权限流到计费对账，每个环节都有结构化防护——不是转发器，是资金级网关。"
            />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div
                  key={f.title}
                  className="rounded-xl border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <span className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <f.icon className="size-5" />
                  </span>
                  <h3 className="mb-2 font-semibold">{f.title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{f.desc}</p>
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
                准备好了吗？一分钟拿到第一个 Key
              </h2>
              <p className="relative mx-auto mb-8 max-w-xl text-sm text-muted-foreground md:text-base">
                注册账户、充值余额、创建密钥，三步接入全部模型——也可以先去操练场免费体验。
              </p>
              <div className="relative flex flex-wrap items-center justify-center gap-4">
                <Button asChild size="lg" className="rounded-full">
                  <Link href={me ? "/dashboard" : "/register"}>
                    {me ? "进入控制台" : "立即注册"} <ArrowRight />
                  </Link>
                </Button>
                {me ? (
                  <Button asChild variant="outline" size="lg" className="rounded-full">
                    <Link href="/dashboard/playground">去操练场试试</Link>
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="lg" className="rounded-full">
                    <Link href="/login">已有账号，去登录</Link>
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
            <p className="text-sm text-muted-foreground">多供应商 LLM 统一网关：一个余额、一份账单、一套限额。</p>
          </div>
          <div>
            <p className="mb-3 text-sm font-medium">快捷入口</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/dashboard" className="hover:text-foreground">进入控制台</Link></li>
              <li><Link href="/dashboard/playground" className="hover:text-foreground">操练场</Link></li>
              <li><Link href="/pricing" className="hover:text-foreground">模型定价</Link></li>
            </ul>
          </div>
          <div>
            <p className="mb-3 text-sm font-medium">开发者</p>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/register" className="hover:text-foreground">注册账号</Link></li>
              <li><Link href="/login" className="hover:text-foreground">登录</Link></li>
              <li><Link href="/dashboard/keys" className="hover:text-foreground">API 密钥管理</Link></li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-center text-xs text-muted-foreground">{APP_CONFIG.copyright}</p>
      </footer>
    </div>
  );
}
