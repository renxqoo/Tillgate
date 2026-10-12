/**
 * 纯逻辑层行为规格：URL 工具（list-query/next-url/auth-url/oauth-fragment）、
 * 展示格式化（format/money-tone/initials/theme-boot）、域内纯推导
 * （sidebar-items/key-params/topup-schema/order-status/kpi/app-config）。
 * 边界与异常约定：垃圾形状不抛、越界回落、白名单封闭。
 */
import { describe, expect, it } from 'vitest';

import { defined } from './defined';

import { firstParam, listHref, parseListSearchParams } from '../src/server/list-query';
import { safeNext } from '../src/server/next-url';
import { stripAuthParams } from '../src/features/auth/auth-url';
import { parseOAuthFragment } from '../src/features/auth/oauth-fragment';
import { isNextRedirect } from '../src/features/auth/next-redirect';
import {
  fmtYuan,
  formatContextLength,
  parseYuan,
  unitLabelKey,
  unitSuffixKey,
} from '../src/features/pricing/pricing-format';
import { oauthOptionsFromProviders } from '../src/features/auth/oauth-options';
import { buildSidebarItems } from '../src/features/shell/sidebar-items';
import { getInitials } from '../src/features/shared/initials';
import { signedAmountTone } from '../src/features/shared/money-tone';
import { formatInt, formatMoney, msToHuman, unitWord } from '../src/features/shared/format';
import { parseDailySpend, parsePositiveInt } from '../src/features/keys/key-params';
import { isValidTopupAmount } from '../src/features/wallet/topup-schema';
import { ORDER_STATUS_KEYS, ORDER_STATUS_TONES } from '../src/features/wallet/order-status';
import { todayCost, todayKey } from '../src/features/dashboard/kpi';
import type { UsageTrendRow } from '@tillgate/api-client';

/** 趋势行测试夹具（模块级——不捕获 describe 变量，lint 口径） */
function trendRow(over: Partial<UsageTrendRow>): UsageTrendRow {
  return {
    bucket: '2026-10-12',
    model: 'gpt-x',
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 2,
    cost: '0.1',
    ...over,
  };
}
import {
  TREND_WINDOW_DAYS,
  compactCount,
  dayKeyMinus,
  fillDailyTrendSeries,
  fillHourlyTrendSeries,
  hourlyBuckets,
  trendWindowFrom,
  zonedDayStart,
} from '../src/features/dashboard/trend-series';
import { getThemeBootCode } from '../src/features/shell/theme-boot';
import { buildPages } from '../src/features/shared/pager-pages';
import { APP_CONFIG } from '../src/config/app-config';
import { actionResult } from '../src/features/shared/action-result';
import { formatDateTime, formatDate } from '../src/features/shared/format';

describe('list-query（URL 参数工具）', () => {
  it('firstParam：数组取首个、空串视为未传', () => {
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('x')).toBe('x');
    expect(firstParam('')).toBeUndefined();
    // eslint-disable-next-line unicorn/no-useless-undefined -- 边界用例：缺参(undefined)输入，参数类型必填故显式传 undefined
    expect(firstParam(undefined)).toBeUndefined();
  });

  it('parseListSearchParams：缺省/垃圾形状回落（页码≥1、方向 desc）', () => {
    expect(parseListSearchParams({})).toEqual({ q: '', page: 1, sortBy: undefined, order: 'desc' });
    expect(parseListSearchParams({ page: 'abc' }).page).toBe(1);
    expect(parseListSearchParams({ page: '-3' }).page).toBe(1);
    expect(parseListSearchParams({ page: '4', order: 'asc' }).order).toBe('asc');
    expect(parseListSearchParams({ order: 'garbage' }).order).toBe('desc');
  });

  it('listHref：保留筛选、overrides 空值删除参数、翻页回第 1 页', () => {
    const sp = { q: 'gpt', model: 'x', page: '3' };
    expect(listHref(sp, { page: 1 })).toBe('?q=gpt&model=x&page=1');
    expect(listHref(sp, { q: undefined })).toBe('?model=x&page=3');
    expect(listHref({})).toBe('');
    // 数组值全部保留（多值筛选）
    expect(listHref({ t: ['a', 'b'] })).toBe('?t=a&t=b');
  });
});

describe('next-url（回跳白名单，防开放重定向）', () => {
  it('站内绝对路径放行，其余一律回落 /dashboard', () => {
    expect(safeNext('/dashboard/keys')).toBe('/dashboard/keys');
    expect(safeNext('/')).toBe('/');
    expect(safeNext('//evil.com')).toBe('/dashboard');
    expect(safeNext('https://evil.com')).toBe('/dashboard');
    expect(safeNext('')).toBe('/dashboard');
    // eslint-disable-next-line unicorn/no-useless-undefined -- 边界用例：缺参(undefined)输入，参数类型必填故显式传 undefined
    expect(safeNext(undefined)).toBe('/dashboard');
    expect(safeNext(null)).toBe('/dashboard');
  });
});

describe('auth-url（登录页参数白名单清理）', () => {
  it('白名单外参数命中即返回干净 URL；无违规返回 null（防循环重定向）', () => {
    expect(stripAuthParams('/login', { next: '/dashboard' }, ['next'])).toBeNull();
    expect(stripAuthParams('/login', { next: '/x', email: 'a@b.c' }, ['next'])).toBe(
      '/login?next=%2Fx',
    );
    expect(stripAuthParams('/login', { email: 'a@b.c' }, ['next'])).toBe('/login');
    // 数组取首个；空串丢弃
    expect(stripAuthParams('/login', { next: ['/a', '/b'], junk: '1' }, ['next'])).toBe(
      '/login?next=%2Fa',
    );
  });
});

describe('oauth-fragment（回调 token 解析）', () => {
  it('提取 #token=…&next=…；next 只接受站内路径', () => {
    expect(parseOAuthFragment('#token=abc&next=/dashboard')).toEqual({
      token: 'abc',
      next: '/dashboard',
    });
    expect(parseOAuthFragment('#token=abc&next=//evil')).toEqual({ token: 'abc', next: null });
    expect(parseOAuthFragment('#error=x')).toEqual({ token: null, next: null });
    expect(parseOAuthFragment('')).toEqual({ token: null, next: null });
    expect(parseOAuthFragment('#token=')).toEqual({ token: null, next: null });
  });
});

describe('oauth-options（登录方式目录）', () => {
  it('词表封闭：恰映射 github/google；未知 provider 忽略', () => {
    expect(oauthOptionsFromProviders(['github'])).toHaveLength(1);
    expect(oauthOptionsFromProviders(['github', 'google'])).toHaveLength(2);
    expect(oauthOptionsFromProviders(['github', 'wechat'])).toHaveLength(1);
    expect(oauthOptionsFromProviders([])).toEqual([]);
  });
});

describe('sidebar-items（邀请开关）', () => {
  it('referralEnabled=false 滤掉 invite 项；其余 12 项保留', () => {
    const withInvite = buildSidebarItems();
    expect(defined(withInvite[0], 'sidebar[0]').items).toHaveLength(13);
    const filtered = buildSidebarItems({ referralEnabled: false });
    expect(defined(filtered[0], 'sidebar[0]').items).toHaveLength(12);
    expect(defined(filtered[0], 'sidebar[0]').items.some((i) => i.id === 'invite')).toBe(false);
  });
});

describe('format（展示格式化）', () => {
  it('formatMoney：2-4 位自适应；无效输入返回 "0"', () => {
    expect(formatMoney('10', 'en')).toBe('¥10.00');
    expect(formatMoney('37.7258', 'en')).toBe('¥37.7258');
    expect(formatMoney('1.5', 'en')).toBe('¥1.50');
    expect(formatMoney('garbage', 'en')).toBe('0');
    expect(formatMoney(null, 'en')).toBe('0');
    expect(formatMoney('-0', 'en')).toBe('¥0.00');
  });

  it('formatInt：四舍五入、无效回落 0', () => {
    expect(formatInt('42')).toBe('42');
    expect(formatInt(1.6)).toBe('2');
    // eslint-disable-next-line unicorn/no-useless-undefined -- 边界用例：缺参(undefined)输入，参数类型必填故显式传 undefined
    expect(formatInt(undefined)).toBe('0');
  });

  it('msToHuman：<1s 显示 ms；≥1s 秒保留 2 位', () => {
    expect(msToHuman(123)).toBe('123ms');
    expect(msToHuman(1500)).toBe('1.50s');
  });

  it('unitWord：zh/en 双语词表 + 未知回落通用词', () => {
    expect(unitWord('image', 'zh')).toBe('张');
    expect(unitWord('image', 'en')).toBe('image');
    expect(unitWord('unknown', 'zh')).toBe('单位');
    expect(unitWord(null, 'en')).toBe('unit');
  });
});

describe('money-tone（正负配色随语言翻转）', () => {
  it('zh 红涨绿跌、en 相反；零/无效不着色', () => {
    expect(signedAmountTone('1.5', 'zh')).toContain('destructive');
    expect(signedAmountTone('-1.5', 'zh')).toContain('emerald');
    expect(signedAmountTone('1.5', 'en')).toContain('emerald');
    expect(signedAmountTone('-1.5', 'en')).toContain('destructive');
    expect(signedAmountTone('0', 'zh')).toBe('');
    expect(signedAmountTone('NaN', 'zh')).toBe('');
  });
});

describe('key-params（限额解析）', () => {
  it('RPM/TPM：留空=不限；正整数放行；非正/非整数拒绝', () => {
    expect(parsePositiveInt(undefined, 'x')).toEqual({ ok: true, value: null });
    expect(parsePositiveInt('', 'x')).toEqual({ ok: true, value: null });
    expect(parsePositiveInt('100', 'x')).toEqual({ ok: true, value: 100 });
    expect(parsePositiveInt('0', 'x')).toEqual({ ok: false, message: 'x' });
    expect(parsePositiveInt('1.5', 'x')).toEqual({ ok: false, message: 'x' });
    expect(parsePositiveInt('abc', 'x')).toEqual({ ok: false, message: 'x' });
  });

  it('每日上限：留空=不限；非负十进制放行；其他形态拒绝', () => {
    expect(parseDailySpend('  ', 'x')).toEqual({ ok: true, value: null });
    expect(parseDailySpend('50', 'x')).toEqual({ ok: true, value: '50' });
    expect(parseDailySpend('50.5', 'x')).toEqual({ ok: true, value: '50.5' });
    expect(parseDailySpend('-1', 'x')).toEqual({ ok: false, message: 'x' });
    expect(parseDailySpend('1e3', 'x')).toEqual({ ok: false, message: 'x' });
  });
});

describe('topup-schema（充值金额界）', () => {
  it('1 元 – 10 万元闭区间放行（分单位精确比较）', () => {
    expect(isValidTopupAmount('1')).toBe(true);
    expect(isValidTopupAmount('0.99')).toBe(false);
    expect(isValidTopupAmount('100000')).toBe(true);
    expect(isValidTopupAmount('100000.01')).toBe(false);
    expect(isValidTopupAmount('10.5')).toBe(true);
  });

  it('形态拒绝：负号/多位小数/千分位/垃圾', () => {
    expect(isValidTopupAmount('-5')).toBe(false);
    expect(isValidTopupAmount('1.234')).toBe(false);
    expect(isValidTopupAmount('1,000')).toBe(false);
    expect(isValidTopupAmount('abc')).toBe(false);
    expect(isValidTopupAmount('')).toBe(false);
  });
});

describe('order-status（订单状态表）', () => {
  it('状态词表封闭：0-4 全映射；tone 词表合法', () => {
    expect(Object.keys(ORDER_STATUS_KEYS).toSorted()).toEqual(['0', '1', '2', '3', '4']);
    for (const tone of Object.values(ORDER_STATUS_TONES)) {
      expect(['success', 'warning', 'neutral']).toContain(tone);
    }
  });
});

describe('kpi（今日费用按显式时区推导——B8 回归）', () => {
  it('todayKey 输出指定时区的 yyyy-MM-dd（UTC 边界用例）', () => {
    // 2026-08-01T17:30Z：上海已是 08-02、UTC 仍是 08-01
    expect(todayKey('Asia/Shanghai', new Date('2026-08-01T17:30:00Z'))).toBe('2026-08-02');
    expect(todayKey('UTC', new Date('2026-08-01T17:30:00Z'))).toBe('2026-08-01');
  });

  it('todayCost 取今天那行费用；无行/垃圾回落 0', () => {
    const rows = [
      {
        date: '2026-08-01',
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        cost: '1.5',
      },
      {
        date: '2026-08-02',
        requests: 2,
        inputTokens: 2,
        outputTokens: 2,
        cachedInputTokens: 0,
        cost: '2.5',
      },
    ];
    const now = new Date('2026-08-02T03:00:00Z');
    expect(todayCost(rows, 'Asia/Shanghai', now)).toBe(2.5);
    expect(todayCost([], 'Asia/Shanghai', now)).toBe(0);
    expect(
      todayCost(
        [
          {
            date: 'bad',
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cost: 'x',
          },
        ],
        'Asia/Shanghai',
        now,
      ),
    ).toBe(0);
  });
});

describe('费用趋势窗口推导（B21 回归：首日半桶 + 断天不补零）', () => {
  const SH_TEN_AM = new Date('2026-08-23T02:00:00Z'); // 上海 08-23 10:00

  it('trendWindowFrom 取起始日当地 00:00（正偏移/负偏移时区；不带时分秒）', () => {
    // 上海窗口起始日 08-10 00:00（+08）= 08-09T16:00Z
    expect(trendWindowFrom(14, 'Asia/Shanghai', SH_TEN_AM).toISOString()).toBe(
      '2026-08-09T16:00:00.000Z',
    );
    // 同一时刻纽约当地仍是 08-22 22:00 → 起始日 08-09 00:00（夏令时 -04）= 08-09T04:00Z
    expect(trendWindowFrom(14, 'America/New_York', SH_TEN_AM).toISOString()).toBe(
      '2026-08-09T04:00:00.000Z',
    );
  });

  it('zonedDayStart 覆盖 DST 切换日（US 2026-11-01 回拨：当地 00:00 仍为 -04）', () => {
    expect(zonedDayStart('2026-11-01', 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
  });

  it('dayKeyMinus 纯日历运算（跨月/非闰年 2 月）', () => {
    expect(dayKeyMinus('2026-08-01', 1)).toBe('2026-07-31');
    expect(dayKeyMinus('2026-03-01', 1)).toBe('2026-02-28');
  });
});

describe('趋势宽表序列（双粒度 + 模型堆叠）', () => {
  const NOW = new Date('2026-10-12T06:30:00Z'); // 上海 10-12 14:30

  it('fillDailyTrendSeries：窗口内补零 14 桶、模型×度量展开、窗口外/垃圾桶键丢弃、同桶同模型合并', () => {
    const { points, models } = fillDailyTrendSeries({
      rows: [
        trendRow({}),
        trendRow({ model: 'claude-y', cost: '0.2', requests: 2 }),
        // 同桶同模型重复行 → 合并（cost 数值相加）
        trendRow({ requests: 3, cost: '0.05' }),
        trendRow({ bucket: '2026-10-11', model: 'claude-y', cost: '1' }),
        // 窗口外
        trendRow({ bucket: '2026-09-01' }),
        // 垃圾桶键（hour 形态混入 day 序列）
        trendRow({ bucket: '2026-10-12T05:00:00' }),
        // 垃圾费用 → 0
        trendRow({ model: 'bad', cost: 'x' }),
      ],
      days: TREND_WINDOW_DAYS,
      timeZone: 'Asia/Shanghai',
      now: NOW,
    });
    expect(points).toHaveLength(14);
    expect(points[13]?.bucket).toBe('2026-10-12');
    expect(points[0]?.bucket).toBe('2026-09-29');
    // 模型全集保序（首现顺序：gpt-x、claude-y、bad）
    expect(models).toEqual(['gpt-x', 'claude-y', 'bad']);
    const [last] = points.slice(-1);
    expect(last?.values['gpt-x::cost']).toBeCloseTo(0.15); // 0.1+0.05 合并
    expect(last?.values['gpt-x::requests']).toBe(4); // 1+3 合并
    expect(last?.values['claude-y::cost']).toBeCloseTo(0.2);
    expect(last?.values['bad::cost']).toBe(0); // 垃圾费用归零
    // 前一天桶只有 claude-y
    const [prev] = points.slice(-2, -1);
    expect(prev?.bucket).toBe('2026-10-11');
    expect(prev?.values['claude-y::cost']).toBe(1);
    expect(prev?.values['gpt-x::cost']).toBe(0); // 补零
  });

  it('fillHourlyTrendSeries：今日 24 桶含未来小时补零、非小时键丢弃', () => {
    const { points, models } = fillHourlyTrendSeries({
      rows: [
        trendRow({ bucket: '2026-10-12T05:00:00', inputTokens: 100 }),
        trendRow({ bucket: '2026-10-12T05:00:00', model: 'claude-y', inputTokens: 50 }),
        trendRow({ bucket: '2026-10-12' }), // 日键混入 → 丢弃
      ],
      timeZone: 'Asia/Shanghai',
      now: NOW,
    });
    expect(points).toHaveLength(24);
    expect(models).toEqual(['gpt-x', 'claude-y']);
    expect(points[0]?.bucket).toBe('2026-10-12T00:00:00');
    expect(points[5]?.bucket).toBe('2026-10-12T05:00:00');
    expect(points[5]?.values['gpt-x::input']).toBe(100);
    expect(points[5]?.values['claude-y::input']).toBe(50);
    // 尾桶 = 今日 23:00（当日完整 24 小时；与后端 hour 窗口同界）
    expect(points[23]?.bucket).toBe('2026-10-12T23:00:00');
    expect(points[23]?.values['gpt-x::input']).toBe(0);
  });

  it('hourlyBuckets 今日当地 00:00 起 24 桶（尾桶 = 今日 23:00）', () => {
    const keys = hourlyBuckets('Asia/Shanghai', NOW);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe('2026-10-12T00:00:00');
    expect(keys[23]).toBe('2026-10-12T23:00:00');
  });

  it('hourlyBuckets 非整点偏移时区（Asia/Kathmandu UTC+05:45）', () => {
    const KTM = new Date('2026-10-12T08:15:00Z'); // 加德满都 10-12 14:00
    const keys = hourlyBuckets('Asia/Kathmandu', KTM);
    expect(keys[0]).toBe('2026-10-12T00:00:00');
    expect(keys[23]).toBe('2026-10-12T23:00:00');
  });

  it('compactCount：Y 轴紧凑单位（K/M/B）——长 token 数曾溢出轴宽被遮挡', () => {
    expect(compactCount(0)).toBe('0');
    expect(compactCount(999)).toBe('999');
    expect(compactCount(1_000)).toBe('1K');
    expect(compactCount(8_500_000)).toBe('8.5M');
    expect(compactCount(17_000_000)).toBe('17M');
    expect(compactCount(440_984_004)).toBe('441M');
    expect(compactCount(1_200_000_000)).toBe('1.2B');
    // 四舍五入一位小数、去尾零
    expect(compactCount(1_250_000)).toBe('1.3M');
    expect(compactCount(2_000_000)).toBe('2M');
    expect(compactCount(-8_500_000)).toBe('-8.5M');
  });

  it('hourlyBuckets DST 切换日：墙钟序 24 键唯一（回归：毫秒步进曾重复/越界）', () => {
    // 美东春跳日（2026-03-08 02:00 不存在）与秋回拨日（2026-11-01 01:00 两次）
    const SPRING = new Date('2026-03-08T15:00:00Z'); // 纽约 03-08 10:00
    const FALL = new Date('2026-11-01T15:00:00Z'); // 纽约 11-01 10:00
    for (const at of [SPRING, FALL]) {
      const keys = hourlyBuckets('America/New_York', at);
      expect(keys).toHaveLength(24);
      expect(new Set(keys).size).toBe(24); // 无重复（秋回拨日 01:00 不出现两次）
      expect(keys.every((k) => k.startsWith('2026-'))).toBe(true);
      expect(keys[0]).toMatch(/T00:00:00$/);
      expect(keys[23]).toMatch(/T23:00:00$/); // 尾桶恒为当日 23:00（春跳日不越到次日）
    }
  });
});

describe('纯展示工具', () => {
  it('initials：单词前两字符/双词首字母/空值兜底', () => {
    expect(getInitials('Alice')).toBe('AL');
    expect(getInitials('Alice Chen')).toBe('AC');
    expect(getInitials('  ')).toBe('?');
  });

  it('theme-boot：读 theme key、system 订阅 prefers-color-scheme、写 dark class', () => {
    const code = getThemeBootCode();
    expect(code).toContain("localStorage.getItem('theme')");
    expect(code).toContain('prefers-color-scheme: dark');
    expect(code).toContain("'dark'");
    expect(code).toContain("'light'");
  });

  it('buildPages：短列表全展开；长列表首尾保留、只缺 1 页补页、缺多页省略号', () => {
    expect(buildPages(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(buildPages(6, 20)).toContain(1);
    expect(buildPages(6, 20)).toContain(20);
    expect(buildPages(9, 20)).toContain('...');
    // 中部页码窗完整连续（8,9,10 无缺口）
    expect(buildPages(9, 20)).toEqual(expect.arrayContaining([8, 9, 10]));
  });
});

describe('app-config（B12 回归：品牌串模板残留修复）', () => {
  it('品牌为 Tillgate Console（非 v1 模板残留 Studio Admin），版本随 package.json', () => {
    expect(APP_CONFIG.name).toBe('Tillgate Console');
    expect(APP_CONFIG.name).not.toContain('Studio Admin');
    expect(APP_CONFIG.version).toBe('0.1.0');
  });
});

describe('action-result（toast 语义）', () => {
  it('error：无标题时错误文案作标题；有标题时作 description；返回 false', () => {
    expect(actionResult({ error: 'boom' })).toBe(false);
    expect(actionResult({ error: 'boom' }, '标题')).toBe(false);
    expect(actionResult({})).toBe(true);
    expect(actionResult({}, undefined, '已创建')).toBe(true);
    expect(actionResult({}, undefined, (res) => `ok:${JSON.stringify(res)}`)).toBe(true);
  });
});

describe('format 日期（DISPLAY_TZ 显式时区——B8）', () => {
  it('按注入时区格式化；空值 —；无效原样返回', () => {
    const out = formatDateTime('2026-08-01T17:30:00Z', 'en');
    expect(out).toContain('Aug');
    expect(out).toContain('2026');
    expect(formatDateTime(null, 'en')).toBe('—');
    expect(formatDateTime('not-a-date', 'en')).toBe('not-a-date');
    expect(formatDate('2026-08-01T17:30:00Z', 'en')).toContain('Aug');
  });

  it('unitWord：second/second-en 分支', () => {
    expect(unitWord('second', 'zh')).toBe('秒');
    expect(unitWord('second', 'en')).toBe('sec');
  });
});

describe('isNextRedirect（NEXT_REDIRECT 判别）', () => {
  it('redirect 的 digest 形态（含 replace/307 后缀）判为跳转信号', () => {
    const err = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/dashboard;307;',
    });
    expect(isNextRedirect(err)).toBe(true);
  });

  it('普通网络错误 / 非 Error / 无 digest 判为真失败', () => {
    expect(isNextRedirect(new Error('fetch failed'))).toBe(false);
    expect(isNextRedirect('NEXT_REDIRECT')).toBe(false);
    expect(isNextRedirect(Object.assign(new Error('x'), { digest: 307 }))).toBe(false);
  });
});

describe('定价页展示格式化（pricing-format）', () => {
  it('parseYuan：十进制串解析；空串 / null / undefined / 非数字回落 null', () => {
    expect(parseYuan('2.5')).toBe(2.5);
    expect(parseYuan('0')).toBe(0);
    expect(parseYuan('')).toBeNull();
    expect(parseYuan(null)).toBeNull();
    // undefined 分支经由「无参」调用覆盖
    expect(parseYuan()).toBeNull();
    expect(parseYuan('abc')).toBeNull();
  });

  it('fmtYuan：¥ 前缀 + 去尾零；0 与 null 渲染占位符（不显示 ¥0 假价）', () => {
    expect(fmtYuan(2)).toBe('¥2');
    expect(fmtYuan(2.1)).toBe('¥2.1');
    expect(fmtYuan(0.025)).toBe('¥0.025');
    expect(fmtYuan(0)).toBe('—');
    expect(fmtYuan(null)).toBe('—');
  });

  it('formatContextLength：千分位取整；0 / null / 缺参渲染占位符', () => {
    expect(formatContextLength(262_144)).toBe('262K');
    expect(formatContextLength(1000)).toBe('1K');
    expect(formatContextLength(0)).toBe('—');
    expect(formatContextLength(null)).toBe('—');
    expect(formatContextLength()).toBe('—');
  });

  it('词表键目录：已知 unit 命中；未知 unit 返回 null（调用方原样回显）', () => {
    expect(unitLabelKey('token')).toBe('unitToken');
    expect(unitLabelKey('char')).toBe('unitChar');
    expect(unitLabelKey('audio')).toBeNull();
    expect(unitSuffixKey('request')).toBe('perRequest');
    expect(unitSuffixKey('token')).toBeNull();
    expect(unitSuffixKey('audio')).toBeNull();
  });
});
