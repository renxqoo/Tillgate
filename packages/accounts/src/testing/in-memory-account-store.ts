/**
 * 内存 AccountStore 替身:与 postgres 适配器同拍演进的行为等价 stand-in(§5.6)。
 * 时间语义 = 注入时钟(对应 postgres 的 clock_timestamp);fake db 的 transaction
 * 用快照/恢复实现回滚——「同生共死」类用例(applyReferral 双侧奖励回滚)可真实断言。
 */
import { ZERO_MARKETING_SETTINGS } from '../domain/marketing.js';

import type {
  AccountStorePort,
  ApiKeyInsert,
  AppInsert,
  LocalUserInsert,
  OAuthUserInsert,
  InvitationInsert,
} from '../ports/account-store.js';

/** 内部可变行形态(时钟由替身注入推进) */
interface UserRow {
  id: number;
  issuer: string;
  subject: string;
  identityProvider: string;
  email: string | null;
  displayName: string | null;
  rateCardId: number | null;
  dailySpendLimit: string | null;
  status: number;
  sessionInvalidBefore: Date | null;
  isEnterprise: boolean;
  freezeReason: string | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface KeyRow {
  id: number;
  keyHash: string;
  keyPreview: string;
  userId: number;
  appId: number | null;
  subscriptionId: number | null;
  name: string;
  remark: string | null;
  expiresAt: Date | null;
  rpmLimit: number | null;
  tpmLimit: number | null;
  dailySpendLimit: string | null;
  allowPaygFallback: boolean;
  status: number;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

interface AppRow {
  id: number;
  appId: string;
  userId: number;
  clientId: string;
  clientSecretHash: string;
  name: string;
  description: string | null;
  subscriptionId: number | null;
  scope: { models?: string[]; rpm?: number; tpm?: number } | null;
  status: number;
  createdAt: Date;
  rotatedAt: Date | null;
}

interface OrgRow {
  id: number;
  name: string;
  ownerUserId: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MemberRow {
  id: number;
  orgId: number;
  userId: number;
  role: string;
  status: number;
  dailySpendLimit: string | null;
  monthlyQuota: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InvitationRow {
  id: number;
  orgId: number;
  email: string;
  token: string;
  invitedByUserId: number | null;
  status: number;
  expiresAt: Date;
  acceptedByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ReferralRow {
  id: number;
  inviterUserId: number;
  inviteeUserId: number;
  status: number;
  createdAt: Date;
}

interface SubscriptionRow {
  id: number;
  userId: number;
  orgId: number | null;
  status: number;
  endAt: Date;
  quantity: number;
}

interface MarketingRow {
  signupGiftAmount: string;
  referralSignupBonus: string;
  referralCommissionRate: string;
  updatedBy: number | null;
  updatedAt: Date;
}

interface RateCardRow {
  id: number;
  name: string;
  status: number;
}

export interface InMemoryState {
  users: Map<number, UserRow>;
  keys: Map<number, KeyRow>;
  apps: Map<number, AppRow>;
  orgs: Map<number, OrgRow>;
  members: Map<number, MemberRow>;
  invitations: Map<number, InvitationRow>;
  referrals: Map<number, ReferralRow>;
  subscriptions: Map<number, SubscriptionRow>;
  rateCards: Map<number, RateCardRow>;
  marketing: MarketingRow | null;
  sequences: {
    user: number;
    key: number;
    app: number;
    org: number;
    member: number;
    invitation: number;
    referral: number;
    subscription: number;
    rateCard: number;
  };
}

export interface InMemoryAccountStore extends AccountStorePort {
  /** 造数口(仅测试):直接注入行 */
  readonly seed: {
    user(row: Partial<UserRow> & { id?: number }): UserRow;
    key(row: Partial<KeyRow> & { id?: number }): KeyRow;
    app(row: Partial<AppRow> & { id?: number }): AppRow;
    org(row: Partial<OrgRow> & { id?: number }): OrgRow;
    member(row: Partial<MemberRow> & { id?: number }): MemberRow;
    invitation(row: Partial<InvitationRow> & { id?: number }): InvitationRow;
    referral(row: Partial<ReferralRow> & { id?: number }): ReferralRow;
    subscription(row: Partial<SubscriptionRow> & { id?: number }): SubscriptionRow;
    rateCard(row: Partial<RateCardRow> & { id?: number }): RateCardRow;
    marketing(row: Partial<MarketingRow>): MarketingRow;
  };
  /** fake db 事务的快照/恢复材料 */
  snapshot(): InMemoryState;
  restore(state: InMemoryState): void;
}

/** 深快照(Map 与行均为纯数据;Date 经 structuredClone 保留) */
function snap(map: Map<number, unknown>): Map<number, unknown> {
  const out = new Map<number, unknown>();
  for (const [k, v] of map) out.set(k, structuredClone(v));
  return out;
}

const pubUser = (r: UserRow) => ({ ...r });
const pubKey = (r: KeyRow) => {
  const { keyHash: _hash, ...rest } = r;
  void _hash;
  return { ...rest };
};
const pubApp = (r: AppRow) => {
  const { clientSecretHash: _h, ...rest } = r;
  void _h;
  return { ...rest };
};

const paginate = <T>(rows: T[], page: number, limit: number) => ({
  rows: rows.slice((page - 1) * limit, (page - 1) * limit + limit),
  total: rows.length,
});

const likeHit = (value: string | null | undefined, q: string): boolean =>
  (value ?? '').toLowerCase().includes(q.toLowerCase());

export function createInMemoryAccountStore(clock: () => Date): InMemoryAccountStore {
  const state: InMemoryState = {
    users: new Map(),
    keys: new Map(),
    apps: new Map(),
    orgs: new Map(),
    members: new Map(),
    invitations: new Map(),
    referrals: new Map(),
    subscriptions: new Map(),
    rateCards: new Map(),
    marketing: null,
    sequences: {
      user: 0,
      key: 0,
      app: 0,
      org: 0,
      member: 0,
      invitation: 0,
      referral: 0,
      subscription: 0,
      rateCard: 0,
    },
  };
  const now = () => clock();

  const localEmailTaken = (email: string, exceptId?: number): boolean =>
    [...state.users.values()].some(
      (u) => u.id !== exceptId && u.issuer === 'local' && u.email === email,
    );

  const activeSubscription = (orgId: number): SubscriptionRow | undefined => {
    const t = now().getTime();
    return [...state.subscriptions.values()].find(
      (s) => s.orgId === orgId && s.status === 0 && s.endAt.getTime() > t,
    );
  };

  const store: InMemoryAccountStore = {
    snapshot: () => ({
      users: snap(state.users) as Map<number, UserRow>,
      keys: snap(state.keys) as Map<number, KeyRow>,
      apps: snap(state.apps) as Map<number, AppRow>,
      orgs: snap(state.orgs) as Map<number, OrgRow>,
      members: snap(state.members) as Map<number, MemberRow>,
      invitations: snap(state.invitations) as Map<number, InvitationRow>,
      referrals: snap(state.referrals) as Map<number, ReferralRow>,
      subscriptions: snap(state.subscriptions) as Map<number, SubscriptionRow>,
      rateCards: snap(state.rateCards) as Map<number, RateCardRow>,
      marketing: state.marketing === null ? null : { ...state.marketing },
      sequences: { ...state.sequences },
    }),
    restore: (s) => {
      state.users = new Map(s.users);
      state.keys = new Map(s.keys);
      state.apps = new Map(s.apps);
      state.orgs = new Map(s.orgs);
      state.members = new Map(s.members);
      state.invitations = new Map(s.invitations);
      state.referrals = new Map(s.referrals);
      state.subscriptions = new Map(s.subscriptions);
      state.rateCards = new Map(s.rateCards);
      state.marketing = s.marketing === null ? null : { ...s.marketing };
      state.sequences = { ...s.sequences };
    },
    seed: {
      user(row) {
        const id = row.id ?? ++state.sequences.user;
        const full: UserRow = {
          id,
          issuer: 'local',
          subject: `subject-${id}`,
          identityProvider: 'local',
          email: null,
          displayName: null,
          rateCardId: null,
          dailySpendLimit: null,
          status: 0,
          sessionInvalidBefore: null,
          isEnterprise: false,
          freezeReason: null,
          rpmLimit: null,
          tpmLimit: null,
          lastLoginAt: null,
          createdAt: now(),
          updatedAt: now(),
          ...row,
        };
        state.users.set(id, full);
        return { ...full };
      },
      key(row) {
        const id = row.id ?? ++state.sequences.key;
        const full: KeyRow = {
          id,
          keyHash: `hash-${id}`,
          keyPreview: `pv-${id}`,
          userId: 0,
          appId: null,
          subscriptionId: null,
          name: `key-${id}`,
          remark: null,
          expiresAt: null,
          rpmLimit: null,
          tpmLimit: null,
          dailySpendLimit: null,
          allowPaygFallback: false,
          status: 0,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: now(),
          ...row,
        };
        state.keys.set(id, full);
        return { ...full };
      },
      app(row) {
        const id = row.id ?? ++state.sequences.app;
        const full: AppRow = {
          id,
          appId: `app-${id}`,
          userId: 0,
          clientId: `client-${id}`,
          clientSecretHash: `sh-${id}`,
          name: `app-${id}`,
          description: null,
          subscriptionId: null,
          scope: null,
          status: 0,
          createdAt: now(),
          rotatedAt: null,
          ...row,
        };
        state.apps.set(id, full);
        return { ...full };
      },
      org(row) {
        const id = row.id ?? ++state.sequences.org;
        const full: OrgRow = {
          id,
          name: `org-${id}`,
          ownerUserId: 0,
          createdAt: now(),
          updatedAt: now(),
          ...row,
        };
        state.orgs.set(id, full);
        return { ...full };
      },
      member(row) {
        const id = row.id ?? ++state.sequences.member;
        const full: MemberRow = {
          id,
          orgId: 0,
          userId: 0,
          role: 'member',
          status: 0,
          dailySpendLimit: null,
          monthlyQuota: null,
          createdAt: now(),
          updatedAt: now(),
          ...row,
        };
        state.members.set(id, full);
        return { ...full };
      },
      invitation(row) {
        const id = row.id ?? ++state.sequences.invitation;
        const full: InvitationRow = {
          id,
          orgId: 0,
          email: '',
          token: `token-${id}`,
          invitedByUserId: null,
          status: 0,
          expiresAt: new Date(now().getTime() + 86_400_000),
          acceptedByUserId: null,
          createdAt: now(),
          updatedAt: now(),
          ...row,
        };
        state.invitations.set(id, full);
        return { ...full };
      },
      referral(row) {
        const id = row.id ?? ++state.sequences.referral;
        const full: ReferralRow = {
          id,
          inviterUserId: 0,
          inviteeUserId: 0,
          status: 0,
          createdAt: now(),
          ...row,
        };
        state.referrals.set(id, full);
        return { ...full };
      },
      subscription(row) {
        const id = row.id ?? ++state.sequences.subscription;
        const full: SubscriptionRow = {
          id,
          userId: 0,
          orgId: null,
          status: 0,
          endAt: new Date(now().getTime() + 30 * 86_400_000),
          quantity: 1,
          ...row,
        };
        state.subscriptions.set(id, full);
        return { ...full };
      },
      rateCard(row) {
        const id = row.id ?? ++state.sequences.rateCard;
        const full: RateCardRow = { id, name: `card-${id}`, status: 0, ...row };
        state.rateCards.set(id, full);
        return { ...full };
      },
      marketing(row) {
        state.marketing = {
          ...ZERO_MARKETING_SETTINGS,
          updatedBy: null,
          updatedAt: now(),
          ...row,
        };
        return { ...state.marketing };
      },
    },

    async insertLocalUser(_db, input: LocalUserInsert) {
      if (localEmailTaken(input.email)) return { status: 'email_taken' };
      const id = ++state.sequences.user;
      const row: UserRow = {
        id,
        issuer: 'local',
        subject: input.email,
        identityProvider: 'local',
        email: input.email,
        displayName: input.displayName,
        rateCardId: null,
        dailySpendLimit: null,
        status: 0,
        sessionInvalidBefore: null,
        isEnterprise: false,
        freezeReason: null,
        rpmLimit: null,
        tpmLimit: null,
        lastLoginAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      state.users.set(id, row);
      return { status: 'created', user: pubUser(row) };
    },

    async insertOAuthUser(_db, input: OAuthUserInsert) {
      const exists = [...state.users.values()].some(
        (u) => u.issuer === input.issuer && u.subject === input.subject,
      );
      if (exists) return { status: 'exists' };
      const id = ++state.sequences.user;
      const row: UserRow = {
        id,
        issuer: input.issuer,
        subject: input.subject,
        identityProvider: input.issuer.slice(0, 16),
        email: input.email,
        displayName: input.displayName,
        rateCardId: null,
        dailySpendLimit: null,
        status: 0,
        sessionInvalidBefore: null,
        isEnterprise: false,
        freezeReason: null,
        rpmLimit: null,
        tpmLimit: null,
        lastLoginAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      state.users.set(id, row);
      return { status: 'created', user: pubUser(row) };
    },

    async findUserByEmail(_db, email) {
      const row = [...state.users.values()].find((u) => u.issuer === 'local' && u.email === email);
      return row ? pubUser(row) : null;
    },
    async findUserById(_db, userId) {
      const row = state.users.get(userId);
      return row ? pubUser(row) : null;
    },
    async findOAuthUser(_db, issuer, subject) {
      const row = [...state.users.values()].find(
        (u) => u.issuer === issuer && u.subject === subject,
      );
      return row ? pubUser(row) : null;
    },
    async getUserProfile(_db, userId) {
      const row = state.users.get(userId);
      if (!row) return null;
      const card = row.rateCardId !== null ? state.rateCards.get(row.rateCardId) : undefined;
      return { ...pubUser(row), rateCardName: card?.name ?? null };
    },
    async updateUser(_db, { userId, patch }) {
      const row = state.users.get(userId);
      if (!row) return null;
      if (patch.displayName !== undefined) row.displayName = patch.displayName;
      if (patch.email !== undefined) row.email = patch.email;
      if (patch.rateCardId !== undefined) row.rateCardId = patch.rateCardId;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.freezeReason !== undefined) row.freezeReason = patch.freezeReason;
      if (patch.rpmLimit !== undefined) row.rpmLimit = patch.rpmLimit;
      if (patch.tpmLimit !== undefined) row.tpmLimit = patch.tpmLimit;
      if (patch.dailySpendLimit !== undefined) row.dailySpendLimit = patch.dailySpendLimit;
      if (patch.isEnterprise !== undefined) row.isEnterprise = patch.isEnterprise;
      row.updatedAt = now();
      return pubUser(row);
    },
    async userExists(_db, userId) {
      return state.users.has(userId);
    },
    async userIsEnterprise(_db, userId) {
      return state.users.get(userId)?.isEnterprise === true;
    },
    async userRateCardBinding(_db, userId) {
      return state.users.get(userId)?.rateCardId ?? null;
    },
    async rateCardUsable(_db, rateCardId) {
      const card = state.rateCards.get(rateCardId);
      if (card === undefined) return { status: 'missing' };
      return card.status === 0 ? { status: 'ok' } : { status: 'disabled' };
    },
    async listUsers(_db, input) {
      let rows = [...state.users.values()].filter((u) => {
        if (input.status !== undefined && u.status !== input.status) return false;
        if (input.enterprise !== undefined && u.isEnterprise !== input.enterprise) return false;
        if (
          input.q &&
          !(
            likeHit(u.subject, input.q) ||
            likeHit(u.email, input.q) ||
            likeHit(u.displayName, input.q)
          )
        ) {
          return false;
        }
        return true;
      });
      const field = input.sort.field as keyof UserRow;
      rows = rows.toSorted((a, b) => {
        const av = a[field];
        const bv = b[field];
        let cmp: number;
        if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
        else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        return (input.sort.order === 'asc' ? cmp : -cmp) || b.id - a.id;
      });
      return paginate(rows.map(pubUser), input.page, input.limit);
    },

    async insertKey(_db, input: ApiKeyInsert) {
      const id = ++state.sequences.key;
      const row: KeyRow = {
        id,
        keyHash: input.keyHash,
        keyPreview: input.keyPreview,
        userId: input.userId,
        appId: null,
        subscriptionId: input.subscriptionId,
        name: input.name,
        remark: input.remark,
        expiresAt: input.expiresAt,
        rpmLimit: input.rpmLimit,
        tpmLimit: input.tpmLimit,
        dailySpendLimit: input.dailySpendLimit,
        allowPaygFallback: input.allowPaygFallback,
        status: 0,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: now(),
      };
      state.keys.set(id, row);
      return pubKey(row);
    },
    async listKeysByUser(_db, input) {
      const rows = [...state.keys.values()]
        .filter((k) => k.userId === input.userId)
        .toSorted((a, b) => b.id - a.id);
      return paginate(rows.map(pubKey), input.page, input.limit);
    },
    async findOwnedKey(_db, { userId, keyId }) {
      const row = state.keys.get(keyId);
      if (!row || row.userId !== userId) return null;
      return pubKey(row);
    },
    async patchKey(_db, { userId, keyId, patch }) {
      const row = state.keys.get(keyId);
      if (!row || row.userId !== userId || row.status !== 0) return null;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.remark !== undefined) row.remark = patch.remark;
      if (patch.rpmLimit !== undefined) row.rpmLimit = patch.rpmLimit;
      if (patch.tpmLimit !== undefined) row.tpmLimit = patch.tpmLimit;
      if (patch.dailySpendLimit !== undefined) row.dailySpendLimit = patch.dailySpendLimit;
      if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
      return pubKey(row);
    },
    async revokeKey(_db, { userId, keyId }) {
      const row = state.keys.get(keyId);
      if (!row || row.userId !== userId || row.status !== 0) return null;
      row.status = 1;
      row.revokedAt = now();
      return pubKey(row);
    },
    async listAdminKeys(_db, input) {
      let rows = [...state.keys.values()].filter((k) => {
        if (input.userId !== undefined && k.userId !== input.userId) return false;
        if (input.status !== undefined && k.status !== input.status) return false;
        if (input.q) {
          const owner = state.users.get(k.userId);
          const hit =
            likeHit(k.name, input.q) ||
            likeHit(k.keyPreview, input.q) ||
            likeHit(owner?.email, input.q) ||
            likeHit(owner?.displayName, input.q);
          if (!hit) return false;
        }
        return true;
      });
      const field = input.sort.field as keyof KeyRow;
      rows = rows.toSorted((a, b) => {
        const av = a[field];
        const bv = b[field];
        let cmp: number;
        if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
        else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
        return (input.sort.order === 'asc' ? cmp : -cmp) || b.id - a.id;
      });
      return paginate(rows.map(pubKey), input.page, input.limit);
    },
    async adminPatchKey(_db, { keyId, patch }) {
      const row = state.keys.get(keyId);
      if (!row) return null;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.remark !== undefined) row.remark = patch.remark;
      if (patch.rpmLimit !== undefined) row.rpmLimit = patch.rpmLimit;
      if (patch.tpmLimit !== undefined) row.tpmLimit = patch.tpmLimit;
      if (patch.dailySpendLimit !== undefined) row.dailySpendLimit = patch.dailySpendLimit;
      if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
      if (patch.status !== undefined) row.status = patch.status;
      return pubKey(row);
    },
    async findActiveKeyByKeyHash(_db, keyHash) {
      const row = [...state.keys.values()].find((k) => k.keyHash === keyHash);
      if (!row || row.status !== 0) return null;
      const owner = state.users.get(row.userId);
      if (!owner || owner.status !== 0) return null;
      if (row.expiresAt !== null && row.expiresAt.getTime() <= now().getTime()) return null;
      return {
        keyId: row.id,
        userId: row.userId,
        subscriptionId: row.subscriptionId,
        rpmLimit: row.rpmLimit,
        tpmLimit: row.tpmLimit,
        dailySpendLimit: row.dailySpendLimit,
        allowPaygFallback: row.allowPaygFallback,
        userRpmLimit: owner.rpmLimit,
        userTpmLimit: owner.tpmLimit,
      };
    },
    async rebindSubscription(_db, { fromSubscriptionId, toSubscriptionId }) {
      let keys = 0;
      let apps = 0;
      for (const k of state.keys.values()) {
        if (k.subscriptionId === fromSubscriptionId) {
          k.subscriptionId = toSubscriptionId;
          keys += 1;
        }
      }
      for (const a of state.apps.values()) {
        if (a.subscriptionId === fromSubscriptionId) {
          a.subscriptionId = toSubscriptionId;
          apps += 1;
        }
      }
      return { keys, apps };
    },

    async insertApp(_db, input: AppInsert) {
      const id = ++state.sequences.app;
      const row: AppRow = {
        id,
        appId: input.appId,
        userId: input.userId,
        clientId: input.clientId,
        clientSecretHash: input.clientSecretHash,
        name: input.name,
        description: input.description,
        subscriptionId: input.subscriptionId,
        scope:
          input.scope === null
            ? null
            : { ...input.scope, models: input.scope.models ? [...input.scope.models] : undefined },
        status: 0,
        createdAt: now(),
        rotatedAt: null,
      };
      state.apps.set(id, row);
      return pubApp(row);
    },
    async listAppsByUser(_db, input) {
      const rows = [...state.apps.values()]
        .filter((a) => a.userId === input.userId)
        .toSorted((a, b) => b.id - a.id);
      return paginate(rows.map(pubApp), input.page, input.limit);
    },
    async findOwnedApp(_db, { userId, appId }) {
      const row = state.apps.get(appId);
      if (!row || row.userId !== userId) return null;
      return pubApp(row);
    },
    async disableApp(_db, { userId, appId }) {
      const row = state.apps.get(appId);
      if (!row || row.userId !== userId || row.status !== 0) return null;
      row.status = 1;
      return pubApp(row);
    },
    async rotateAppSecret(_db, { userId, appId, clientSecretHash }) {
      const row = state.apps.get(appId);
      if (!row || row.userId !== userId || row.status !== 0) return null;
      row.clientSecretHash = clientSecretHash;
      row.rotatedAt = now();
      return pubApp(row);
    },
    async findActiveAppByAppId(_db, appId) {
      const row = [...state.apps.values()].find((a) => a.appId === appId);
      if (!row || row.status !== 0) return null;
      const owner = state.users.get(row.userId);
      if (!owner || owner.status !== 0) return null;
      return {
        id: row.id,
        appId: row.appId,
        userId: row.userId,
        scope: row.scope,
        subscriptionId: row.subscriptionId,
      };
    },
    async findActiveAppByClient(_db, { clientId, clientSecretHash }) {
      const row = [...state.apps.values()].find(
        (a) => a.clientId === clientId && a.clientSecretHash === clientSecretHash,
      );
      if (!row || row.status !== 0) return null;
      const owner = state.users.get(row.userId);
      if (!owner || owner.status !== 0) return null;
      return {
        id: row.id,
        appId: row.appId,
        userId: row.userId,
        scope: row.scope,
        subscriptionId: row.subscriptionId,
      };
    },

    async insertOrgWithOwner(_db, { name, ownerUserId }) {
      const orgId = ++state.sequences.org;
      const t = now();
      state.orgs.set(orgId, { id: orgId, name, ownerUserId, createdAt: t, updatedAt: t });
      const memberId = ++state.sequences.member;
      state.members.set(memberId, {
        id: memberId,
        orgId,
        userId: ownerUserId,
        role: 'owner',
        status: 0,
        dailySpendLimit: null,
        monthlyQuota: null,
        createdAt: t,
        updatedAt: t,
      });
      // 两行前刚写入;守卫仅类型收窄,缺失即内存替身状态被外部破坏
      const org = state.orgs.get(orgId);
      if (org === undefined) throw new Error(`in-memory store: org ${orgId} missing after insert`);
      return { ...org };
    },
    async findOrg(_db, orgId) {
      const row = state.orgs.get(orgId);
      return row ? { ...row } : null;
    },
    async findActiveMembership(_db, { orgId, userId }) {
      const row = [...state.members.values()].find(
        (m) => m.orgId === orgId && m.userId === userId && m.status === 0,
      );
      return row ? { ...row } : null;
    },
    async listMembershipsForUser(_db, userId) {
      return [...state.members.values()]
        .filter((m) => m.userId === userId && m.status === 0)
        .map((m) => ({ ...m, orgName: state.orgs.get(m.orgId)?.name ?? '' }));
    },
    async listMembers(_db, orgId) {
      return [...state.members.values()]
        .filter((m) => m.orgId === orgId)
        .toSorted((a, b) => a.id - b.id)
        .map((m) => {
          const u = state.users.get(m.userId);
          return {
            userId: m.userId,
            displayName: u?.displayName ?? null,
            email: u?.email ?? null,
            subject: u?.subject ?? `subject-${m.userId}`,
            role: m.role,
            status: m.status,
            dailySpendLimit: m.dailySpendLimit,
            monthlyQuota: m.monthlyQuota,
            joinedAt: m.createdAt,
          };
        });
    },
    async countActiveMembers(_db, orgId) {
      return [...state.members.values()].filter((m) => m.orgId === orgId && m.status === 0).length;
    },
    async countPendingInvitations(_db, orgId) {
      const t = now().getTime();
      return [...state.invitations.values()].filter(
        (i) => i.orgId === orgId && i.status === 0 && i.expiresAt.getTime() > t,
      ).length;
    },
    async insertInvitation(_db, input: InvitationInsert) {
      const id = ++state.sequences.invitation;
      const t = now();
      const row: InvitationRow = {
        id,
        orgId: input.orgId,
        email: input.email,
        token: input.token,
        invitedByUserId: input.invitedByUserId,
        status: 0,
        expiresAt: new Date(t.getTime() + input.ttlMs),
        acceptedByUserId: null,
        createdAt: t,
        updatedAt: t,
      };
      state.invitations.set(id, row);
      return { ...row };
    },
    async findInvitationByToken(_db, token) {
      const row = [...state.invitations.values()].find((i) => i.token === token);
      if (!row) return null;
      return { ...row, expired: row.expiresAt.getTime() <= now().getTime() };
    },
    async listPendingInvitations(_db, orgId) {
      const t = now().getTime();
      return [...state.invitations.values()]
        .filter((i) => i.orgId === orgId && i.status === 0 && i.expiresAt.getTime() > t)
        .toSorted((a, b) => b.id - a.id)
        .map(({ token: _t, ...rest }) => {
          void _t;
          return { ...rest };
        });
    },
    async revokeInvitation(_db, { orgId, invitationId }) {
      const row = state.invitations.get(invitationId);
      if (!row || row.orgId !== orgId || row.status !== 0) return false;
      row.status = 2;
      row.updatedAt = now();
      return true;
    },
    async insertOrReviveMember(_db, { orgId, userId, role }) {
      const existing = [...state.members.values()].find(
        (m) => m.orgId === orgId && m.userId === userId,
      );
      if (existing === undefined) {
        const id = ++state.sequences.member;
        state.members.set(id, {
          id,
          orgId,
          userId,
          role,
          status: 0,
          dailySpendLimit: null,
          monthlyQuota: null,
          createdAt: now(),
          updatedAt: now(),
        });
        return;
      }
      // setWhere status=1 语义:仅被移除成员复活;active 行无害幂等
      if (existing.status === 1) {
        existing.status = 0;
        existing.role = role;
        existing.updatedAt = now();
      }
    },
    async acceptInvitation(_db, { invitationId, acceptedByUserId }) {
      const row = state.invitations.get(invitationId);
      if (!row || row.status !== 0 || row.expiresAt.getTime() <= now().getTime()) return false;
      row.status = 1;
      row.acceptedByUserId = acceptedByUserId;
      row.updatedAt = now();
      return true;
    },
    async findActiveOrgSubscription(_db, orgId) {
      const row = activeSubscription(orgId);
      return row ? { id: row.id, quantity: row.quantity } : null;
    },
    async lockActiveOrgSubscription(_db, orgId) {
      const row = activeSubscription(orgId);
      return row ? { id: row.id, quantity: row.quantity } : null;
    },
    async patchMember(_db, { orgId, userId, patch }) {
      const row = [...state.members.values()].find((m) => m.orgId === orgId && m.userId === userId);
      if (!row || row.status !== 0) return null;
      if (patch.dailySpendLimit !== undefined) row.dailySpendLimit = patch.dailySpendLimit;
      if (patch.monthlyQuota !== undefined) row.monthlyQuota = patch.monthlyQuota;
      row.updatedAt = now();
      return { ...row };
    },
    async removeMember(_db, { orgId, userId }) {
      const row = [...state.members.values()].find(
        (m) => m.orgId === orgId && m.userId === userId && m.status === 0,
      );
      if (!row) return false;
      row.status = 1;
      row.updatedAt = now();
      return true;
    },
    async findUsableSubscription(_db, { userId, subscriptionId }) {
      const t = now().getTime();
      const sub = state.subscriptions.get(subscriptionId);
      if (!sub || sub.status !== 0 || sub.endAt.getTime() <= t) return null;
      if (sub.userId === userId) return { userId: sub.userId, orgId: sub.orgId };
      if (sub.orgId === null) return null;
      const member = [...state.members.values()].find(
        (m) => m.orgId === sub.orgId && m.userId === userId && m.status === 0,
      );
      return member ? { userId: sub.userId, orgId: sub.orgId } : null;
    },
    async memberLimits(_db, { orgId, userId }) {
      const row = [...state.members.values()].find((m) => m.orgId === orgId && m.userId === userId);
      if (!row) return null;
      return { dailySpendLimit: row.dailySpendLimit, monthlyQuota: row.monthlyQuota };
    },

    async inviterActive(_db, inviterUserId) {
      const row = state.users.get(inviterUserId);
      return row !== undefined && row.status === 0;
    },
    async insertReferral(_db, { inviterUserId, inviteeUserId }) {
      const exists = [...state.referrals.values()].some((r) => r.inviteeUserId === inviteeUserId);
      if (exists) return 'already_referred';
      const id = ++state.sequences.referral;
      state.referrals.set(id, { id, inviterUserId, inviteeUserId, status: 0, createdAt: now() });
      return 'created';
    },
    async listInvitees(_db, { inviterUserId, limit }) {
      return [...state.referrals.values()]
        .filter((r) => r.inviterUserId === inviterUserId)
        .toSorted((a, b) => b.id - a.id)
        .slice(0, limit)
        .map((r) => {
          const u = state.users.get(r.inviteeUserId);
          return {
            inviteeUserId: r.inviteeUserId,
            inviteeEmail: u?.email ?? null,
            inviteeDisplayName: u?.displayName ?? null,
            status: r.status,
            createdAt: r.createdAt,
          };
        });
    },
    async getMarketingSettings(_db) {
      if (state.marketing === null) {
        return {
          ...ZERO_MARKETING_SETTINGS,
          updatedBy: null,
          updatedAt: new Date(0),
        };
      }
      return { ...state.marketing };
    },
    async upsertMarketingSettings(_db, { patch, updatedBy }) {
      const base: MarketingRow =
        state.marketing === null
          ? {
              ...ZERO_MARKETING_SETTINGS,
              updatedBy: null,
              updatedAt: new Date(0),
            }
          : { ...state.marketing };
      if (patch.signupGiftAmount !== undefined) base.signupGiftAmount = patch.signupGiftAmount;
      if (patch.referralSignupBonus !== undefined) {
        base.referralSignupBonus = patch.referralSignupBonus;
      }
      if (patch.referralCommissionRate !== undefined) {
        base.referralCommissionRate = patch.referralCommissionRate;
      }
      base.updatedBy = updatedBy;
      base.updatedAt = now();
      state.marketing = base;
      return { ...base };
    },
    async listReferralRelations(_db, input) {
      const rows = [...state.referrals.values()]
        .filter((r) => {
          if (!input.q) return true;
          const inviter = state.users.get(r.inviterUserId);
          const invitee = state.users.get(r.inviteeUserId);
          return (
            likeHit(inviter?.email, input.q) ||
            likeHit(inviter?.displayName, input.q) ||
            likeHit(invitee?.email, input.q) ||
            likeHit(invitee?.displayName, input.q)
          );
        })
        .toSorted((a, b) => b.id - a.id)
        .map((r) => {
          const inviter = state.users.get(r.inviterUserId);
          const invitee = state.users.get(r.inviteeUserId);
          return {
            id: r.id,
            inviterUserId: r.inviterUserId,
            inviterEmail: inviter?.email ?? null,
            inviterDisplayName: inviter?.displayName ?? null,
            inviteeUserId: r.inviteeUserId,
            inviteeEmail: invitee?.email ?? null,
            inviteeDisplayName: invitee?.displayName ?? null,
            status: r.status,
            createdAt: r.createdAt,
          };
        });
      return paginate(rows, input.page, input.limit);
    },
    async setReferralRelationStatus(_db, { relationId, status }) {
      const row = state.referrals.get(relationId);
      if (!row) return null;
      row.status = status;
      const inviter = state.users.get(row.inviterUserId);
      const invitee = state.users.get(row.inviteeUserId);
      return {
        id: row.id,
        inviterUserId: row.inviterUserId,
        inviterEmail: inviter?.email ?? null,
        inviterDisplayName: inviter?.displayName ?? null,
        inviteeUserId: row.inviteeUserId,
        inviteeEmail: invitee?.email ?? null,
        inviteeDisplayName: invitee?.displayName ?? null,
        status: row.status,
        createdAt: row.createdAt,
      };
    },
  };
  return store;
}
