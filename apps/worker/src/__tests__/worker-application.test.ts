import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from '@ai-gateway/core';

describe('worker runtime configuration boundary', () => {
  it('rejects unsafe retry and claim configuration', () => {
    expect(() => loadWorkerEnv({ ENCRYPTION_KEY: 'unit-test-encryption-key-32-bytes!!', WORKER_CLAIM_LEASE_MS: '0' })).toThrow();
    expect(() => loadWorkerEnv({ ENCRYPTION_KEY: 'unit-test-encryption-key-32-bytes!!', WORKER_MAX_SETTLEMENT_ATTEMPTS: '0' })).toThrow();
    expect(() => loadWorkerEnv({ ENCRYPTION_KEY: 'unit-test-encryption-key-32-bytes!!', WORKER_POLL_INTERVAL_MS: '10' })).toThrow();
    expect(() =>
      loadWorkerEnv({ ENCRYPTION_KEY: 'unit-test-encryption-key-32-bytes!!', WORKER_RETRY_BASE_MS: '5000', WORKER_RETRY_MAX_MS: '1000' }),
    ).toThrow();
    expect(() =>
      loadWorkerEnv({ ENCRYPTION_KEY: 'unit-test-encryption-key-32-bytes!!', WORKER_CLAIM_LEASE_MS: '1000', WORKER_POLL_INTERVAL_MS: '1000' }),
    ).toThrow();
  });

  it('provides production-safe lifecycle defaults', () => {
    const env = loadWorkerEnv({ ENCRYPTION_KEY: 'unit-test-encryption-key-32-bytes!!' });
    expect(env.WORKER_CLAIM_BATCH_SIZE).toBeGreaterThan(0);
    expect(env.WORKER_CLAIM_LEASE_MS).toBeGreaterThan(env.WORKER_POLL_INTERVAL_MS);
    expect(env.WORKER_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(env.WORKER_MAX_SETTLEMENT_ATTEMPTS).toBeGreaterThan(1);
  });
});
