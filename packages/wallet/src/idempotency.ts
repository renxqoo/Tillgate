import { createHash } from 'node:crypto';
import { IdempotencyConflictError } from './errors';

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | CanonicalObject;
type CanonicalObject = { readonly [key: string]: CanonicalValue | undefined };

function canonicalize(value: CanonicalValue | undefined): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/** Stable command identity: equivalent normalized commands produce the same digest. */
export function commandFingerprint(kind: string, payload: CanonicalObject): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ kind, ...payload })))
    .digest('hex');
}

/** Null is accepted only for rows created before command fingerprints were introduced. */
export function assertCommandFingerprint(
  stored: string | null,
  expected: string,
  refType: string,
  refId: string,
  kind: string,
): void {
  if (stored !== null && stored !== expected) {
    throw new IdempotencyConflictError(refType, refId, kind);
  }
}
