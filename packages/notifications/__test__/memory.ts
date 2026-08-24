/**
 * 内存 store stand-in(§5.6 类型 2:PostgreSQL 的行为等价替身)——默认门禁专用。
 * 与 adapters/postgres 同契约实现;关键语义模拟:
 * - 认领单赢家(检查与置位之间无 await——内存天然原子);
 * - 租约 fencing(complete/fail/record 校验 owner+token+claimUntil>now);
 * - 退避/终态判定(attempts+1 >= maxAttempts → sentAt 置位);
 * - 唯一约束以 23505 形状错误模拟(isUniqueViolation 按 cause 链 code 判定)。
 * 时钟可拨(lease 到期/退避到期用例);真实 SQL 行为等价由 postgres.real.test.ts 承担。
 */
import type { Db, DbTx } from '@tillgate/db';
import type {
  NotifyStore,
  ChannelInsertInput,
  ChannelPatchInput,
  ClaimInput,
  ClaimFencing,
  ClaimedNotification,
} from '../src/ports/notify-store';
import type { NotificationChannel } from '../src/domain/channel';
import type { Notifications } from '../src/notifications';
import { createNotifications } from '../src/notifications';

/** PG 唯一冲突同形错误 */
export function uniqueViolation(constraint: string): Error {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  (err as { code?: string }).code = '23505';
  (err as { constraint?: string }).constraint = constraint;
  return err;
}

/** db 事务替身:单事务直通 */
export function createMemoryDb(): Db {
  return {
    async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      return fn({} as DbTx);
    },
  } as unknown as Db;
}

export interface MemoryOutboxRow {
  id: number;
  event: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  attempts: number;
  lastError: string | null;
  deliveredChannelIds: number[];
  nextAttemptAt: number;
  claimOwner: string | null;
  claimToken: string | null;
  claimUntil: number | null;
  sentAt: Date | null;
}

/** 内部可变渠道行(NotificationChannel 出口只读,替身内部维护可变态;events 放宽 string[] 承载合成事件) */
export interface MutableChannel {
  id: number;
  name: string;
  type: NotificationChannel['type'];
  config: Record<string, unknown>;
  events: string[];
  status: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryNotifyStoreState {
  channels: Map<number, MutableChannel>;
  outbox: Map<number, MemoryOutboxRow>;
  /** 毫秒时钟(可拨) */
  now: number;
}

export interface MemoryNotifyStore {
  store: NotifyStore;
  state: MemoryNotifyStoreState;
  /** 直插 outbox(合成事件/绕过词表——与 v1 测试直插 DB 同能力) */
  seedOutbox(row: {
    event: string;
    payload?: Record<string, unknown>;
    dedupeKey?: string;
    attempts?: number;
  }): number;
  /** 种渠道(events 收 string[]——合成事件测试与词表门测试共用) */
  seedChannel(channel: {
    id?: number;
    name: string;
    type: NotificationChannel['type'];
    config: Record<string, unknown>;
    events: string[];
    status: number;
  }): number;
  outboxRow(id: number): MemoryOutboxRow | undefined;
  pendingRows(): MemoryOutboxRow[];
}

/** 出口快照(events 拷贝断开内部引用;放宽的 string[] 经形态断言回到词表契约面) */
const snapshot = (row: MutableChannel): NotificationChannel =>
  ({ ...row, events: [...row.events] }) as NotificationChannel;

export function createMemoryNotifyStore(startAt = 1_700_000_000_000): MemoryNotifyStore {
  const state: MemoryNotifyStoreState = {
    channels: new Map<number, MutableChannel>(),
    outbox: new Map<number, MemoryOutboxRow>(),
    now: startAt,
  };
  let nextChannelId = 1;
  let nextOutboxId = 1;
  let nextToken = 1;
  const byDedupe = new Set<string>();

  const fencing = (input: ClaimFencing, row: MemoryOutboxRow): boolean =>
    row.sentAt === null &&
    row.claimOwner === input.ownerId &&
    row.claimToken === input.claimToken &&
    row.claimUntil !== null &&
    row.claimUntil > state.now;

  const store: NotifyStore = {
    async listChannels(_db, filter) {
      const rows = [...state.channels.values()]
        .filter((c) => !filter.activeOnly || c.status === 0)
        .toSorted((a, b) => a.id - b.id);
      return rows.map(snapshot);
    },
    async findChannel(_db, id) {
      const row = state.channels.get(id);
      return row ? snapshot(row) : null;
    },
    async insertChannel(_db, input: ChannelInsertInput) {
      for (const existing of state.channels.values()) {
        if (existing.name === input.name) throw uniqueViolation('notification_channels_name_uq');
      }
      const row: MutableChannel = {
        id: nextChannelId++,
        createdAt: new Date(state.now),
        updatedAt: new Date(state.now),
        name: input.name,
        type: input.type,
        config: { ...input.config },
        events: [...input.events],
        status: input.status ?? 0,
      };
      state.channels.set(row.id, row);
      return snapshot(row);
    },
    async patchChannel(_db, input: { channelId: number; patch: ChannelPatchInput }) {
      const row = state.channels.get(input.channelId);
      if (!row) return null;
      if (input.patch.name !== undefined) row.name = input.patch.name;
      if (input.patch.config !== undefined) row.config = { ...input.patch.config };
      if (input.patch.events !== undefined) row.events = [...input.patch.events];
      if (input.patch.status !== undefined) row.status = input.patch.status;
      row.updatedAt = new Date(state.now);
      return snapshot(row);
    },
    async removeChannel(_db, id) {
      return state.channels.delete(id);
    },
    async insertOutboxEvent(_db, input) {
      if (byDedupe.has(input.dedupeKey)) return; // onConflictDoNothing
      byDedupe.add(input.dedupeKey);
      const row: MemoryOutboxRow = {
        id: nextOutboxId++,
        event: input.event,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
        attempts: 0,
        lastError: null,
        deliveredChannelIds: [],
        nextAttemptAt: state.now,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        sentAt: null,
      };
      state.outbox.set(row.id, row);
    },
    async claimPending(_db, input: ClaimInput): Promise<ClaimedNotification[]> {
      const claimed: ClaimedNotification[] = [];
      for (const row of [...state.outbox.values()].toSorted((a, b) => a.id - b.id)) {
        if (claimed.length >= input.limit) break;
        if (row.sentAt !== null) continue;
        if (row.attempts >= input.maxAttempts) continue;
        if (row.nextAttemptAt > state.now) continue;
        if (row.claimUntil !== null && row.claimUntil > state.now) continue;
        row.claimOwner = input.ownerId;
        row.claimToken = `mem-token-${nextToken++}`;
        row.claimUntil = state.now + input.leaseMs;
        claimed.push({
          id: row.id,
          event: row.event,
          payload: row.payload,
          attempts: row.attempts,
          claimToken: row.claimToken,
          deliveredChannelIds: [...row.deliveredChannelIds],
        });
      }
      return claimed;
    },
    async recordDeliveredChannels(_db, input: ClaimFencing & { channelIds: number[] }) {
      if (input.channelIds.length === 0) return true;
      const row = state.outbox.get(input.id);
      if (!row || !fencing(input, row)) return false;
      row.deliveredChannelIds = [...row.deliveredChannelIds, ...input.channelIds];
      return true;
    },
    async completeClaim(_db, input: ClaimFencing) {
      const row = state.outbox.get(input.id);
      if (!row || !fencing(input, row)) return false;
      row.sentAt = new Date(state.now);
      row.attempts += 1;
      row.lastError = null;
      row.claimOwner = null;
      row.claimToken = null;
      row.claimUntil = null;
      return true;
    },
    async failClaim(
      _db,
      input: ClaimFencing & { maxAttempts: number; error: string; retryDelayMs: number },
    ) {
      const row = state.outbox.get(input.id);
      if (!row || !fencing(input, row)) return false;
      row.attempts += 1;
      row.lastError = input.error.slice(0, 255);
      if (row.attempts >= input.maxAttempts) {
        row.sentAt = new Date(state.now);
        row.nextAttemptAt = state.now;
      } else {
        row.nextAttemptAt = state.now + input.retryDelayMs;
      }
      row.claimOwner = null;
      row.claimToken = null;
      row.claimUntil = null;
      return true;
    },
  };

  return {
    store,
    state,
    seedOutbox(row) {
      const id = nextOutboxId++;
      byDedupe.add(row.dedupeKey ?? `seed:${id}`);
      state.outbox.set(id, {
        id,
        event: row.event,
        payload: row.payload ?? {},
        dedupeKey: row.dedupeKey ?? `seed:${id}`,
        attempts: row.attempts ?? 0,
        lastError: null,
        deliveredChannelIds: [],
        nextAttemptAt: state.now,
        claimOwner: null,
        claimToken: null,
        claimUntil: null,
        sentAt: null,
      });
      return id;
    },
    seedChannel(channel) {
      const id = channel.id ?? nextChannelId++;
      const row: MutableChannel = {
        id,
        createdAt: new Date(state.now),
        updatedAt: new Date(state.now),
        name: channel.name,
        type: channel.type,
        config: channel.config,
        events: [...channel.events],
        status: channel.status,
      };
      state.channels.set(id, row);
      if (id >= nextChannelId) nextChannelId = id + 1;
      return id;
    },
    outboxRow(id) {
      return state.outbox.get(id);
    },
    pendingRows() {
      return [...state.outbox.values()].filter((r) => r.sentAt === null);
    },
  };
}

// ── 测试假件 ─────────────────────────────────────────────────────────────────

/** 假 cipher:enc:v1:fake:<base64> 往返;非本形态解密抛错(测 fail-closed 链) */
export function fakeCipher() {
  return {
    encrypt(plaintext: string): string {
      return `enc:v1:fake:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
    },
    decrypt(packed: string): string {
      if (!packed.startsWith('enc:v1:fake:')) throw new Error('bad ciphertext');
      return Buffer.from(packed.slice('enc:v1:fake:'.length), 'base64').toString('utf8');
    },
  };
}

export interface RecordedWebhookCall {
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
  deliveryId: string;
}

/** 可编程 webhook 投递替身:按 url 决定成败(缺省恒真),记录全部调用;behavior 可实时改写 */
export function fakeWebhookDeliverer(opts: { failUrls?: string[]; delayMs?: number } = {}) {
  const calls: RecordedWebhookCall[] = [];
  const behavior = { failUrls: opts.failUrls ?? [], delayMs: opts.delayMs ?? 0 };
  return {
    calls,
    behavior,
    async deliver(input: RecordedWebhookCall) {
      if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
      calls.push(input);
      return !behavior.failUrls.includes(input.url);
    },
  };
}

/** 邮件发送替身:记录 (to, subject, text);可编程抛错 */
export function fakeEmailSender(opts: { failTo?: string } = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  return {
    sent,
    async send(to: string, subject: string, text: string) {
      if (opts.failTo && to === opts.failTo) throw new Error('smtp down');
      sent.push({ to, subject, text });
    },
  };
}

/** SSRF 守卫替身:全放行(逃生门结果值) */
export const permissiveUrlGuard = {
  async assert(url: string): Promise<URL> {
    return new URL(url);
  },
};

export const noopLogger = { warn: () => undefined };

export const testDispatchConfig = {
  claimLeaseMs: 60_000,
  maxAttempts: 3,
  loopBatchLimit: 50,
  webhookTimeoutMs: 10_000,
  backoffBaseMs: 15_000,
  backoffCapMs: 300_000,
  emailBrand: 'AI Gateway',
};

/** 组装 facade(内存 store + 假件;覆盖件透传) */
export function buildFacade(
  overrides: {
    memory?: MemoryNotifyStore;
    emailSender?: { send(to: string, subject: string, text: string): Promise<void> };
    webhookDeliverer?: { deliver(input: RecordedWebhookCall): Promise<boolean> };
    config?: Partial<typeof testDispatchConfig>;
  } = {},
): { facade: Notifications; memory: MemoryNotifyStore } {
  const memory = overrides.memory ?? createMemoryNotifyStore();
  const facade = createNotifications({
    db: createMemoryDb(),
    cipher: fakeCipher(),
    urlGuard: permissiveUrlGuard,
    ...(overrides.emailSender !== undefined ? { emailSender: overrides.emailSender } : {}),
    logger: noopLogger,
    webhookAllowLocalUrl: true,
    store: memory.store,
    ...(overrides.webhookDeliverer !== undefined
      ? { webhookDeliverer: overrides.webhookDeliverer }
      : {}),
    config: { ...testDispatchConfig, ...overrides.config },
  });
  return { facade, memory };
}
