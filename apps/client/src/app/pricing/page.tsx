import { TagIcon } from 'lucide-react';
import Link from 'next/link';

import { fetchPublicPricing, PRICING_UNIT_LABEL } from '../../lib/public-pricing';

export const dynamic = 'force-dynamic';

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

export default async function PricingPage() {
  const models = await fetchPublicPricing();
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
      </header>
      {models === null ? (
        <p className="text-sm text-muted-foreground">定价服务暂不可用，请稍后再试。</p>
      ) : (
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
              {models.map((m) => (
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
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-6 text-sm text-muted-foreground">
        <Link href="/register" className="underline">注册</Link>即送体验额度；定价单位为人民币（元）。
      </p>
    </main>
  );
}
