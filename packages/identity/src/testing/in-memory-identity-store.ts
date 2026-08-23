/**
 * 内存 identity store(默认门禁测试替身):以 JS 语义模拟 PG 行为——
 * 部分唯一索引(活挑战同 kind 同目标至多一条)、CAS(验码计错+命中消费、TOTP 步进
 * 单调、恢复码单次消费)、锚点 GREATEST 单调、冷却判定(注入时钟)。
 * snapshot/restore 供 fake db 的 transaction 实现回滚语义(accounts harness 同款)。
 */
import type { NormalizedIdentifier } from '../domain/identifier.js';
import type { Clock } from '../ports/clock.js';
import type { CredentialStore, RegisterCredentialOutcome } from '../ports/credential-store.js';
import type {
  BeginChallengeOutcome,
  ChallengeStore,
  StoredChallengeTarget,
  VerifyChallengeResult,
} from '../ports/challenge-store.js';
import type {
  ConfirmEnrollmentOutcome,
  MfaStore,
  TotpRow,
  UpsertEnrollmentOutcome,
} from '../ports/mfa-store.js';
import type { LinkOutcome, OAuthStore, UnlinkOutcome } from '../ports/oauth-store.js';
import type { AnchorStore } from '../ports/anchor-store.js';

interface ChallengeRow {
  id: string;
  kind: string;
  identifier: NormalizedIdentifier | null;
  userId: number | null;
  codeHash: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
  issuedAt: number;
  expiresAt: number;
  consumedAt: number | null;
  abortedAt: number | null;
}

interface StoreState {
  credentialSeq: number;
  linkSeq: number;
  credentials: Array<{ kind: string; value: string; id: number; userId: number }>;
  passwords: Array<{ userId: number; passwordHash: string }>;
  links: Array<{
    id: number;
    userId: number;
    provider: string;
    subject: string;
    email: string | null;
  }>;
  challenges: ChallengeRow[];
  totp: Array<{ userId: number; secret: string; confirmedAt: number | null; lastUsedStep: number }>;
  recoveryCodes: Array<{ userId: number; codeHash: string; usedAt: number | null }>;
  anchors: Array<{ realm: string; userId: number; invalidBefore: number }>;
}

export interface InMemoryIdentityStoreSnapshot {
  readonly state: StoreState;
}

export interface InMemoryIdentityStore
  extends CredentialStore, ChallengeStore, MfaStore, OAuthStore, AnchorStore {
  snapshot(): InMemoryIdentityStoreSnapshot;
  restore(snap: InMemoryIdentityStoreSnapshot): void;
}

function initialState(): StoreState {
  return {
    credentialSeq: 0,
    linkSeq: 0,
    credentials: [],
    passwords: [],
    links: [],
    challenges: [],
    totp: [],
    recoveryCodes: [],
    anchors: [],
  };
}

export function createInMemoryIdentityStore(clock: Clock): InMemoryIdentityStore {
  let state = initialState();

  const findCredential = (identifier: NormalizedIdentifier) =>
    state.credentials.find((c) => c.kind === identifier.kind && c.value === identifier.value);
  const liveChallenge = (
    kind: string,
    identifier: NormalizedIdentifier | null,
    userId: number | null,
  ) =>
    state.challenges.find(
      (row) =>
        row.kind === kind &&
        ((identifier != null &&
          row.identifier != null &&
          row.identifier.kind === identifier.kind &&
          row.identifier.value === identifier.value) ||
          (identifier == null && row.userId != null && row.userId === userId)) &&
        row.consumedAt == null &&
        row.abortedAt == null,
    );

  const store: InMemoryIdentityStore = {
    snapshot() {
      return { state: structuredClone(state) };
    },
    restore(snap) {
      state = structuredClone(snap.state);
    },

    async registerCredential(_db, input): Promise<RegisterCredentialOutcome> {
      const existing = findCredential(input.identifier);
      if (existing == null) {
        state.credentialSeq += 1;
        state.credentials.push({
          kind: input.identifier.kind,
          value: input.identifier.value,
          id: state.credentialSeq,
          userId: input.userId,
        });
        return { status: 'created', credentialId: state.credentialSeq };
      }
      if (existing.userId !== input.userId) return { status: 'taken' };
      return { status: 'replay', credentialId: existing.id };
    },

    async upsertPassword(_db, input) {
      const row = state.passwords.find((p) => p.userId === input.userId);
      if (row != null) row.passwordHash = input.passwordHash;
      else state.passwords.push({ userId: input.userId, passwordHash: input.passwordHash });
    },

    async findPasswordHashByIdentifier(_db, identifier) {
      const cred = findCredential(identifier);
      if (cred == null) return null;
      const hash = state.passwords.find((p) => p.userId === cred.userId);
      return hash == null ? null : { userId: cred.userId, passwordHash: hash.passwordHash };
    },

    async loadPasswordHash(_db, userId) {
      return state.passwords.find((p) => p.userId === userId)?.passwordHash ?? null;
    },

    async updatePassword(_db, input) {
      const row = state.passwords.find((p) => p.userId === input.userId);
      if (row == null) return false;
      row.passwordHash = input.passwordHash;
      return true;
    },

    async resetPassword(_db, input) {
      const row = state.passwords.find((p) => p.userId === input.userId);
      if (row != null) row.passwordHash = input.passwordHash;
      else state.passwords.push({ userId: input.userId, passwordHash: input.passwordHash });
    },

    async findDeliveryIdentifier(_db, userId) {
      const rows = state.credentials
        .filter((c) => c.userId === userId)
        .slice()
        .sort((a, b) => {
          const rank = (kind: string) => (kind === 'email' ? 0 : kind === 'phone' ? 1 : 2);
          return rank(a.kind) - rank(b.kind) || a.id - b.id;
        });
      const first = rows[0];
      if (first == null || (first.kind !== 'email' && first.kind !== 'phone')) return null;
      return { kind: first.kind as 'email' | 'phone', value: first.value };
    },

    async hasPassword(_db, userId) {
      return state.passwords.some((p) => p.userId === userId);
    },

    async beginChallenge(_db, input): Promise<BeginChallengeOutcome> {
      const now = clock.now().getTime();
      const live = liveChallenge(input.kind, input.identifier, input.userId);
      if (live != null) {
        const elapsedMs = now - live.issuedAt;
        if (elapsedMs < input.cooldownMs) {
          return { status: 'cooldown', retryAfterMs: Math.max(0, input.cooldownMs - elapsedMs) };
        }
        live.abortedAt = now;
      }
      const row: ChallengeRow = {
        id: input.challengeId,
        kind: input.kind,
        identifier: input.identifier,
        userId: input.userId,
        codeHash: input.codeHash,
        payload: input.payload,
        attempts: 0,
        maxAttempts: input.maxAttempts,
        issuedAt: now,
        expiresAt: now + input.ttlMs,
        consumedAt: null,
        abortedAt: null,
      };
      state.challenges.push(row);
      return { status: 'inserted', expiresAt: new Date(row.expiresAt).toISOString() };
    },

    async verifyChallenge(_db, input): Promise<VerifyChallengeResult> {
      const row = state.challenges.find((c) => c.id === input.challengeId);
      if (
        row == null ||
        row.consumedAt != null ||
        row.abortedAt != null ||
        row.expiresAt <= clock.now().getTime() ||
        row.attempts >= row.maxAttempts
      ) {
        return { status: 'invalid' };
      }
      row.attempts += 1;
      if (row.codeHash === input.codeHash) {
        row.consumedAt = clock.now().getTime();
        const target: StoredChallengeTarget =
          row.identifier != null
            ? { identifier: row.identifier, userId: null }
            : { identifier: null, userId: row.userId };
        return { status: 'consumed', target, payload: row.payload };
      }
      return {
        status: 'wrong_code',
        remainingAttempts: Math.max(0, row.maxAttempts - row.attempts),
      };
    },

    async abortChallenge(_db, input) {
      const row = state.challenges.find((c) => c.id === input.challengeId);
      if (row == null || row.consumedAt != null || row.abortedAt != null) {
        return { aborted: false };
      }
      row.abortedAt = clock.now().getTime();
      return { aborted: true };
    },

    async loadTotp(_db, userId): Promise<TotpRow | null> {
      const row = state.totp.find((t) => t.userId === userId);
      return row
        ? {
            secret: row.secret,
            confirmedAt: row.confirmedAt != null ? new Date(row.confirmedAt).toISOString() : null,
            lastUsedStep: row.lastUsedStep,
          }
        : null;
    },

    async upsertEnrollment(_db, input): Promise<UpsertEnrollmentOutcome> {
      const row = state.totp.find((t) => t.userId === input.userId);
      if (row != null && row.confirmedAt != null) return { status: 'already_confirmed' };
      if (row != null) {
        row.secret = input.storedSecret;
        row.confirmedAt = null;
        row.lastUsedStep = -1;
        return { status: 'pending_replaced' };
      }
      state.totp.push({
        userId: input.userId,
        secret: input.storedSecret,
        confirmedAt: null,
        lastUsedStep: -1,
      });
      return { status: 'pending_created' };
    },

    async confirmEnrollment(_db, input): Promise<ConfirmEnrollmentOutcome> {
      const row = state.totp.find((t) => t.userId === input.userId);
      if (row == null) return { status: 'not_enrolled' };
      if (row.confirmedAt != null) return { status: 'already_confirmed' };
      row.confirmedAt = clock.now().getTime();
      row.lastUsedStep = input.step;
      state.recoveryCodes = state.recoveryCodes.filter((c) => c.userId !== input.userId);
      const seen = new Set<string>();
      for (const codeHash of input.recoveryCodeHashes) {
        if (seen.has(codeHash)) continue;
        seen.add(codeHash);
        state.recoveryCodes.push({ userId: input.userId, codeHash, usedAt: null });
      }
      return { status: 'confirmed' };
    },

    async advanceTotpStep(_db, input) {
      const row = state.totp.find((t) => t.userId === input.userId);
      if (row == null || row.confirmedAt == null) return false;
      if (row.lastUsedStep >= input.step) return false;
      row.lastUsedStep = input.step;
      return true;
    },

    async consumeRecoveryCode(_db, input) {
      const row = state.recoveryCodes.find(
        (c) => c.userId === input.userId && c.codeHash === input.codeHash && c.usedAt == null,
      );
      if (row == null) return false;
      row.usedAt = clock.now().getTime();
      return true;
    },

    async deleteTotpAndRecoveryCodes(_db, userId) {
      state.totp = state.totp.filter((t) => t.userId !== userId);
      state.recoveryCodes = state.recoveryCodes.filter((c) => c.userId !== userId);
    },

    async findUser(_db, input) {
      const link = state.links.find(
        (l) => l.provider === input.provider && l.subject === input.subject,
      );
      return link?.userId ?? null;
    },

    async link(_db, input): Promise<LinkOutcome> {
      const bySubject = state.links.find(
        (l) => l.provider === input.provider && l.subject === input.subject,
      );
      const byUser = state.links.find(
        (l) => l.userId === input.userId && l.provider === input.provider,
      );
      if (bySubject == null && byUser == null) {
        state.linkSeq += 1;
        state.links.push({
          id: state.linkSeq,
          userId: input.userId,
          provider: input.provider,
          subject: input.subject,
          email: input.email,
        });
        return { status: 'linked', linkId: state.linkSeq };
      }
      if (
        bySubject != null &&
        byUser != null &&
        bySubject.id === byUser.id &&
        bySubject.userId === input.userId
      ) {
        return { status: 'replay', linkId: bySubject.id };
      }
      if (bySubject != null && bySubject.userId !== input.userId) {
        return { status: 'provider_identity_taken' };
      }
      if (byUser != null) return { status: 'user_already_linked' };
      // 不可能分支(内存态双判皆空已在上方返回)
      return { status: 'provider_identity_taken' };
    },

    async unlink(_db, input): Promise<UnlinkOutcome> {
      const link = state.links.find(
        (l) => l.userId === input.userId && l.provider === input.provider,
      );
      if (link == null) return { status: 'not_found' };
      const hasPassword = state.passwords.some((p) => p.userId === input.userId);
      const hasOtherLink = state.links.some((l) => l.userId === input.userId && l.id !== link.id);
      if (!hasPassword && !hasOtherLink) return { status: 'last_credential' };
      state.links.splice(state.links.indexOf(link), 1);
      return { status: 'unlinked', linkId: link.id };
    },

    async advanceAnchor(_db, input) {
      const at = input.at != null ? input.at.getTime() : clock.now().getTime();
      const row = state.anchors.find((a) => a.realm === input.realm && a.userId === input.userId);
      if (row != null) {
        row.invalidBefore = Math.max(row.invalidBefore, at);
      } else {
        state.anchors.push({ realm: input.realm, userId: input.userId, invalidBefore: at });
      }
      const current = state.anchors.find(
        (a) => a.realm === input.realm && a.userId === input.userId,
      )!;
      return new Date(current.invalidBefore).toISOString();
    },

    async readAnchor(_db, input) {
      const row = state.anchors.find((a) => a.realm === input.realm && a.userId === input.userId);
      return row == null ? null : new Date(row.invalidBefore).toISOString();
    },
  };
  return store;
}
