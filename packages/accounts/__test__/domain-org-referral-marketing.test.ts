/**
 * 组织/邀请、推荐(aff 码与幂等键词表)、拉新参数域:表驱动矩阵。
 */
import { describe, expect, it } from 'vitest';
import {
  pendingInvitationLimit,
  generateInvitationToken,
  invitationEmailMatches,
  MEMBER_ROLES,
} from '../src/domain/org.js';
import {
  encodeAffCode,
  decodeAffCode,
  signupGiftRefId,
  referralSignupRefId,
  commissionRefId,
  commissionAmount,
  inviteUrl,
} from '../src/domain/referral.js';
import {
  validateMarketingPatch,
  referralProgramEnabled,
  ZERO_MARKETING_SETTINGS,
} from '../src/domain/marketing.js';
import { validateAppScope } from '../src/domain/app.js';

const V1_PENDING = { factor: 2, cap: 20 };

describe('待接受邀请上限公式(v1 min(max(剩余,1)×2, 20) 等价)', () => {
  it('v1 测试锁定值:qty=2,owner 占 1 → 剩余 1 → 上限 2', () => {
    expect(pendingInvitationLimit(1, V1_PENDING)).toBe(2);
  });
  it('剩余 0(席位满)仍允许 1×2=2 个 pending(防刷邀请行的有意设计)', () => {
    expect(pendingInvitationLimit(0, V1_PENDING)).toBe(2);
  });
  it('大剩余被封顶 20', () => {
    expect(pendingInvitationLimit(50, V1_PENDING)).toBe(20);
  });
  it('注入因子生效(零写死)', () => {
    expect(pendingInvitationLimit(3, { factor: 3, cap: 10 })).toBe(9);
    expect(pendingInvitationLimit(3, { factor: 3, cap: 8 })).toBe(8);
  });
});

describe('邀请 token', () => {
  it('32 hex 且唯一', () => {
    const a = generateInvitationToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(generateInvitationToken());
  });
  it('email 匹配:email 一致或无 email 时按 subject 兜底(v1 语义)', () => {
    expect(invitationEmailMatches({ email: 'A@X.IO', subject: 's' }, 'a@x.io')).toBe(true);
    expect(invitationEmailMatches({ email: null, subject: 'GH123' }, 'gh123')).toBe(true);
    expect(invitationEmailMatches({ email: 'a@x.io', subject: 's' }, 'b@x.io')).toBe(false);
  });
  it('MEMBER_ROLES 词汇', () => {
    expect(MEMBER_ROLES).toEqual({ OWNER: 'owner', MEMBER: 'member' });
  });
});

describe('aff 码编解码(纯函数往返封闭)', () => {
  it.each([1, 35, 1000, 123456789])('userId %d 往返', (id) => {
    expect(decodeAffCode(encodeAffCode(id))).toBe(id);
  });
  it('编码形态:u + base36', () => {
    expect(encodeAffCode(35)).toBe('uz'); // 35 → 'z'
    expect(encodeAffCode(36)).toBe('u10');
  });
  it.each([
    ['', '空'],
    ['z10', '无 u 前缀'],
    ['u', '仅前缀'],
    ['u0', 'u0'],
    ['u1G12', '大写非法'],
    ['u01', '非规范形态(前导零)'],
    [`u${'z'.repeat(40)}`, '超长'],
  ])('decodeAffCode(%j) 拒绝(%s)', (input) => {
    expect(decodeAffCode(input as string)).toBeNull();
  });
});

describe('钱包幂等键构造器(单一真相,v1 两处前缀漂移的收敛)', () => {
  it('词表精确', () => {
    expect(signupGiftRefId(7)).toBe('signup:7');
    expect(referralSignupRefId(9, 'inviter')).toBe('referral-signup:9:inviter');
    expect(referralSignupRefId(9, 'invitee')).toBe('referral-signup:9:invitee');
    expect(commissionRefId(5, '20260823')).toBe('referral-commission:5:20260823');
  });
  it('佣金全精度(不四舍五入)', () => {
    expect(commissionAmount('15.5', '0.1')).toBe('1.55');
    expect(commissionAmount('10', '0.333333')).toBe('3.33333');
  });
  it('邀请链接:基址注入(v1 localhost 写死已清除)', () => {
    expect(inviteUrl('https://console.example.com', 'u10')).toBe(
      'https://console.example.com/register?aff=u10',
    );
  });
});

describe('拉新参数域', () => {
  it.each([
    [{ signupGiftAmount: '0' }, null],
    [{ signupGiftAmount: '12.5' }, null],
    [{ referralCommissionRate: '1' }, null],
    [{ referralCommissionRate: '0.33' }, null],
    [{ signupGiftAmount: '-1' }, ['signupGiftAmount']],
    [{ referralCommissionRate: '1.1' }, ['referralCommissionRate']],
    [{ referralSignupBonus: '1e3' }, ['referralSignupBonus']],
    [{ referralSignupBonus: '12345678901' }, ['referralSignupBonus']], // 整数超 10 位
    [{ referralCommissionRate: '0.1234567890123456789' }, ['referralCommissionRate']], // 小数超 18 位
  ])('validateMarketingPatch(%j) → %s', (patch, expected) => {
    expect(validateMarketingPatch(patch as Record<string, string | undefined>)).toEqual(expected);
  });
  it('开关:任一激励 >0 即 enabled;全 0 关闭', () => {
    expect(referralProgramEnabled({ ...ZERO_MARKETING_SETTINGS, referralSignupBonus: '0.1' })).toBe(
      true,
    );
    expect(
      referralProgramEnabled({ ...ZERO_MARKETING_SETTINGS, referralCommissionRate: '0.01' }),
    ).toBe(true);
    expect(referralProgramEnabled(ZERO_MARKETING_SETTINGS)).toBe(false);
  });
});

describe('App scope 域', () => {
  const policy = { rpmLimitMax: 1_000_000, tpmLimitMax: 100_000_000, scopeModelsMax: 100 };
  it('合法 scope', () => {
    expect(validateAppScope({ models: ['gpt-4o'], rpm: 100 }, policy)).toBeNull();
    expect(validateAppScope({}, policy)).toBeNull();
  });
  it.each([
    [{ models: [] }, null],
    [{ models: ['x'.repeat(65)] }, ['models']],
    [{ models: Array.from({ length: 101 }, (_, i) => `m${i}`) }, ['models']],
    [{ models: ['ok', 42 as unknown as string] }, ['models']],
    [{ rpm: 0 }, ['rpm']],
    [{ rpm: 1_000_001 }, ['rpm']],
    [{ tpm: -1 }, ['tpm']],
  ])('validateAppScope(%j) → %s', (scope, expected) => {
    const invalid = validateAppScope(
      scope as { models?: string[]; rpm?: number; tpm?: number },
      policy,
    );
    if (expected === null) expect(invalid).toBeNull();
    else expect(invalid).toEqual(expected);
  });
});
