/**
 * postgres identity store 组装器:五聚合查询件合成(一聚合一 SQL 文件,本文件只组装;
 * accounts 的 account-store.ts 同款)。仅根装配面(identity.ts/composition.ts)可引用。
 */
import type { CredentialStore } from '../../ports/credential-store.js';
import type { ChallengeStore } from '../../ports/challenge-store.js';
import type { MfaStore } from '../../ports/mfa-store.js';
import type { OAuthStore } from '../../ports/oauth-store.js';
import type { AnchorStore } from '../../ports/anchor-store.js';
import { credentialQueries } from './credentials.js';
import { passwordQueries } from './passwords.js';
import { challengeQueries } from './challenges.js';
import { mfaQueries } from './mfa.js';
import { oauthQueries } from './oauth.js';
import { anchorQueries } from './anchors.js';

export interface PostgresIdentityStore
  extends CredentialStore, ChallengeStore, MfaStore, OAuthStore, AnchorStore {}

export const postgresIdentityStore: PostgresIdentityStore = {
  ...credentialQueries,
  ...passwordQueries,
  ...challengeQueries,
  ...mfaQueries,
  ...oauthQueries,
  ...anchorQueries,
};
