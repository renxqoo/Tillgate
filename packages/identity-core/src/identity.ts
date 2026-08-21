/** 装配层：createIdentity(db, options) → 18 个动词（一动词一事，实现分布见各域文件） */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { resolveContext } from './context.js';
import { registerCredential } from './credentials.js';
import { authenticate, changePassword, resetPassword } from './passwords.js';
import { abortChallenge, beginChallenge, verifyChallenge } from './challenge.js';
import { findOAuthUser, linkOAuth, unlinkOAuth } from './oauth.js';
import { confirmTotp, disableTotp, enrollTotp, verifyMfa } from './mfa.js';
import { revokeSessions, sessionValidAt } from './revocation.js';
import type { CreateIdentityOptions, Identity } from './types.js';

export function createIdentity(db: NodePgDatabase, options: CreateIdentityOptions): Identity {
  const ctx = resolveContext(options);
  return {
    registerCredential: (input) => registerCredential(db, input, ctx),
    authenticate: (input) => authenticate(db, input, ctx),
    changePassword: (input) => changePassword(db, input, ctx),
    resetPassword: (input) => resetPassword(db, input, ctx),
    beginChallenge: (input) => beginChallenge(db, input, ctx),
    verifyChallenge: (input) => verifyChallenge(db, input),
    abortChallenge: (input) => abortChallenge(db, input),
    findOAuthUser: (input) => findOAuthUser(db, input, ctx),
    linkOAuth: (input) => linkOAuth(db, input, ctx),
    unlinkOAuth: (input) => unlinkOAuth(db, input, ctx),
    enrollTotp: (input) => enrollTotp(db, input, ctx),
    confirmTotp: (input) => confirmTotp(db, input, ctx),
    verifyMfa: (input) => verifyMfa(db, input, ctx),
    disableTotp: (input) => disableTotp(db, input, ctx),
    revokeSessions: (input) => revokeSessions(db, input, ctx),
    sessionValidAt: (input) => sessionValidAt(db, input),
  };
}
