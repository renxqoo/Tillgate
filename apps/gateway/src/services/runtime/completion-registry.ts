/** 追踪客户端断开后仍必须完成的 durable billing promise。 */
export class CompletionRegistry {
  private readonly active = new Set<Promise<unknown>>();

  track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => {});
    return promise;
  }

  async drain(timeoutMs: number): Promise<{ completed: boolean; remaining: number }> {
    const all = Promise.allSettled(this.active);
    const completed = await Promise.race([
      all.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return { completed, remaining: this.active.size };
  }

  get size(): number {
    return this.active.size;
  }
}
