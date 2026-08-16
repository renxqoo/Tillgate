/** 追踪客户端断开后仍必须完成的 durable billing promise。 */
export interface CompletionRegistry {
  track<T>(promise: Promise<T>): Promise<T>;
  drain(timeoutMs: number): Promise<{ completed: boolean; remaining: number }>;
  readonly size: number;
}

export function createCompletionRegistry(): CompletionRegistry {
  const active = new Set<Promise<unknown>>();

  return {
    track<T>(promise: Promise<T>): Promise<T> {
      active.add(promise);
      void promise.finally(() => active.delete(promise)).catch(() => {});
      return promise;
    },

    async drain(timeoutMs: number): Promise<{ completed: boolean; remaining: number }> {
      const all = Promise.allSettled(active);
      const completed = await Promise.race([
        all.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      return { completed, remaining: active.size };
    },

    get size(): number {
      return active.size;
    },
  };
}
