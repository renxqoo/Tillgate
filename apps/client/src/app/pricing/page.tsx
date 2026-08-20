import { SearchIcon, TagIcon } from 'lucide-react';
import Link from 'next/link';

import { Input } from '@ai-gateway/ui/components/ui/input';
import { Pager } from '@ai-gateway/ui/components/ui/pager';

import { fetchPublicPricing, PRICING_UNIT_LABEL } from '../../lib/public-pricing';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

function fmtYuanPerMillion(price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return '—';
  // 元/百万token 展示为 ¥/1M
  return `¥${n}`;
}

function fmtUnitPrice(unit: string, price: string): string {
  const n = Number(price);
  if (!Number.isFinite(n) || n === 0) return '—';
  const suffix = unit === 'request' ? '/次' : unit === 'image' ? '/张' : unit === 'second' ? '/秒' : unit === 'char' ? '/字符' : '';
  return `¥${n}${suffix}`;
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = ((Array.isArray(sp.q) ? sp.q[0] : sp.q) ?? '').trim();
  const page = Math.max(1, Number.parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? '1', 10) || 1);
  const data = await fetchPublicPricing({ q, page, pageSize: PAGE_SIZE });

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8 flex items-center gap-3">
        <TagIcon className="size-7 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">模型定价</h1>
          <p className="text-sm text-muted-foreground">
            官方价口径；登录后按账户费率卡展示到手价
          </p>
        </div>
        {/* 原生 GET 搜索：提交即回第 1 页 */}
        <form method="GET" className="relative ml-auto">
          <SearchIcon className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={q} placeholder="搜索模型…" className="w-52 pl-9" />
        </form>
      </header>
      {data === null ? (
        <p className="text-sm text-muted-foreground">定价服务暂不可用，请稍后再试。</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">模型</th>
                  <th className="px-4 py-2 font-medium">计费方式</th>
                  <th className="px-4 py-2 text-right font-medium">输入</th>
                  <th className="px-4 py-2 text-right font-medium">输出</th>
                  <th className="px-4 py-2 text-right font-medium">缓存命中</th>
                  <th className="px-4 py-2 text-right font-medium">单位价</th>
                  <th className="px-4 py-2 text-right font-medium">上下文</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="px-4 py-2 font-mono text-xs">
                      {m.externalName}
                      {m.isFree ? <span className="ml-2 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600">免费</span> : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{PRICING_UNIT_LABEL[m.pricingUnit] ?? m.pricingUnit}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? fmtYuanPerMillion(m.inputPrice) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? fmtYuanPerMillion(m.outputPrice) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? fmtYuanPerMillion(m.cacheInputPrice) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {m.pricingUnit === 'token' ? '—' : fmtUnitPrice(m.pricingUnit, m.unitPrice)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">
                      {m.contextLength ? `${Math.round(m.contextLength / 1000)}K` : '—'}
                    </td>
                  </tr>
                ))}
                {data.models.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      没有匹配「{q}」的模型
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Pager page={page} totalPages={Math.max(1, Math.ceil(data.total / PAGE_SIZE))} total={data.total} searchParams={q ? { q } : {}} />
          </div>
        </>
      )}
      <p className="mt-6 text-sm text-muted-foreground">
        <Link href="/register" className="underline">注册</Link>即送体验额度；定价单位为人民币（元）。
      </p>
    </main>
  );
}
