import type { PricingModel, PricingScheduleWindow } from '@tillgate/api-client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@tillgate/ui';

import {
  DASH,
  fmtYuan,
  formatContextLength,
  parseYuan,
  unitLabelKey,
  unitSuffixKey,
} from './pricing-format';

/** next-intl t 的最小调用面（传参收窄，避免整份 Translator 类型穿透） */
export type PricingT = (key: string, values?: Record<string, string | number>) => string;

/** 令牌制价格的「标签 / 金额」一行 */
function priceLine(label: string, value: number | null) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[11px] text-slate-400">{label}</span>
      <span className="font-mono text-sm tabular-nums text-slate-900">{fmtYuan(value)}</span>
    </div>
  );
}

/** 单位价文本（含 /次 /张 等后缀）；价格缺失时只返回占位符 */
function unitPriceText(unit: string, price: string, t: PricingT): string {
  const value = parseYuan(price);
  if (value === null) return DASH;
  const suffixKey = unitSuffixKey(unit);
  return `${fmtYuan(value)}${suffixKey ? t(suffixKey) : ''}`;
}

/**
 * 价格单元格：token 制三轴（输入 / 输出 / 缓存命中）纵向排列，其余制单行单位价。
 * 两种计费方式互斥（同一行只会出现一种），故合为一列——不再留整列「—」的空列。
 * 免费模型整格给「免费」结语（而非三行破折号——空占形态读起来像故障）。
 */
function renderPriceCell(m: PricingModel, t: PricingT) {
  if (m.isFree) {
    return (
      <div className="flex items-baseline justify-end gap-3">
        <span className="text-[11px] text-slate-400">{t('colPrice')}</span>
        <span className="text-sm font-medium text-emerald-600">{t('freeBadge')}</span>
      </div>
    );
  }
  if (m.pricingUnit !== 'token') {
    // 未知计价单位无后缀词表键，此时以原样单位串充当标签（不出现空标签）
    const suffixKey = unitSuffixKey(m.pricingUnit);
    return (
      <div className="flex items-baseline justify-end gap-3">
        <span className="text-[11px] text-slate-400">
          {suffixKey ? t('colUnitPrice') : m.pricingUnit}
        </span>
        <span className="font-mono text-sm tabular-nums text-slate-900">
          {unitPriceText(m.pricingUnit, m.unitPrice, t)}
        </span>
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {priceLine(t('colInput'), parseYuan(m.inputPrice))}
      {priceLine(t('colOutput'), parseYuan(m.outputPrice))}
      {priceLine(t('colCacheHit'), parseYuan(m.cacheInputPrice))}
    </div>
  );
}

/** 时段窗口的价格文本：token 制走输入/输出轴，其余制走单位价；缺轴回落到模型基价 */
function windowPriceText(m: PricingModel, w: PricingScheduleWindow, t: PricingT): string {
  if (m.pricingUnit === 'token') {
    return t('scheduleInOut', {
      input: fmtYuan(parseYuan(w.inputPrice ?? m.inputPrice)),
      output: fmtYuan(parseYuan(w.outputPrice ?? m.outputPrice)),
    });
  }
  return unitPriceText(m.pricingUnit, w.unitPrice ?? m.unitPrice, t);
}

/** 单个时段：标签（可空）· 时钟区间 · 该窗口价格 */
function renderWindow(w: PricingScheduleWindow, m: PricingModel, t: PricingT) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      {w.label ? <span className="text-slate-500">{w.label}</span> : null}
      <span className="font-mono tabular-nums text-slate-500">
        {w.start}–{w.end}
      </span>
      <span className="font-mono tabular-nums text-slate-700">{windowPriceText(m, w, t)}</span>
    </span>
  );
}

/**
 * 时段单元格：分时段窗口逐条列出（无时段策略 = 单格占位符）。
 * 旧实现用 colSpan 覆盖全表的子 <tr> 承载这段信息，且子 <tr> 嵌在模型 <tr> 内
 * （无效 HTML，浏览器解析结果不可预期）——现改为模型行内的独立单元格。
 */
function renderScheduleCell(m: PricingModel, t: PricingT) {
  if (!m.schedule || m.schedule.length === 0) return <span className="text-slate-300">{DASH}</span>;
  return (
    <div className="space-y-1">
      {m.schedule.map((w, i) => (
        <div key={`${w.start}-${i}`} className="text-xs">
          {renderWindow(w, m, t)}
        </div>
      ))}
    </div>
  );
}

/** 计费方式单元格：目录化单位词；未知 unit 原样回显（后端新增计价方式时不至于空白） */
function renderBillingCell(m: PricingModel, t: PricingT) {
  const key = unitLabelKey(m.pricingUnit);
  return (
    <span className="whitespace-nowrap text-xs text-slate-500">{key ? t(key) : m.pricingUnit}</span>
  );
}

/** 模型名单元格：等宽模型名 + 免费徽标 */
function renderModelCell(m: PricingModel, t: PricingT) {
  return (
    <div className="flex items-center gap-2">
      <span className="truncate font-mono text-[13px] font-medium text-slate-900">
        {m.externalName}
      </span>
      {m.isFree ? (
        <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
          {t('freeBadge')}
        </span>
      ) : null}
    </div>
  );
}

/** 上下文列：等宽数字右对齐 */
function renderContextCell(m: PricingModel) {
  return (
    <span className="font-mono text-xs tabular-nums text-slate-500">
      {formatContextLength(m.contextLength)}
    </span>
  );
}

/** 表头单元格（统一灰字，禁用默认 hover 变色） */
function headCell(className: string, label: string) {
  return <TableHead className={`text-slate-500 ${className}`}>{label}</TableHead>;
}

/**
 * 价格列表头：目录内存在 token 制模型时带上「¥ / 1M Token」口径后缀
 * （单位价制模型的价格以 /次、/张 后缀自带单位，无需口径说明）。
 */
function priceHeadLabel(models: readonly PricingModel[], t: PricingT): string {
  return models.some((m) => m.pricingUnit === 'token') ? t('colPriceToken') : t('colPrice');
}

/**
 * 定价目录表：5 列（模型 / 计费方式 / 价格 / 分时段 / 上下文）。
 * 排版属营销页家族（固定浅色系，与首页同族），Table 自带横向滚动容器，
 * 窄屏不破版。
 */
export function PricingTable({ models, t }: { models: readonly PricingModel[]; t: PricingT }) {
  return (
    <Table className="text-sm">
      <TableHeader className="bg-slate-50">
        <TableRow className="hover:bg-slate-50">
          {headCell('w-[28%] min-w-44 pl-5', t('colModel'))}
          {headCell('min-w-20', t('colBilling'))}
          {headCell('min-w-40 text-right', priceHeadLabel(models, t))}
          {headCell('min-w-52', t('colSchedule'))}
          {headCell('min-w-24 pr-5 text-right', t('colContext'))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((m) => (
          <TableRow key={m.id} className="hover:bg-slate-50/70">
            <TableCell className="max-w-0 py-3 pl-5">{renderModelCell(m, t)}</TableCell>
            <TableCell className="py-3 align-top">{renderBillingCell(m, t)}</TableCell>
            <TableCell className="py-3 align-top">{renderPriceCell(m, t)}</TableCell>
            <TableCell className="py-3 align-top">{renderScheduleCell(m, t)}</TableCell>
            <TableCell className="py-3 pr-5 text-right align-top">{renderContextCell(m)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
