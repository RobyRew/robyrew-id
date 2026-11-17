/** Token buckets per key, in memory (one process). `take` is false once a key ran out. */
export function createRateLimiter(options: { capacity: number; refillEveryMs: number; now?: () => number }) {
  const now = options.now ?? Date.now
  const buckets = new Map<string, { tokens: number; at: number }>()
  return {
    take(key: string): boolean {
      const t = now()
      const bucket = buckets.get(key) ?? { tokens: options.capacity, at: t }
      const refill = Math.floor((t - bucket.at) / options.refillEveryMs)
      if (refill > 0) {
        bucket.tokens = Math.min(options.capacity, bucket.tokens + refill)
        bucket.at += refill * options.refillEveryMs
      }
      if (bucket.tokens <= 0) {
        buckets.set(key, bucket)
        return false
      }
      bucket.tokens--
      buckets.set(key, bucket)
      // Bounded memory: drop the oldest keys when the map grows large.
      if (buckets.size > 10_000) {
        for (const k of buckets.keys()) {
          buckets.delete(k)
          if (buckets.size <= 5_000) break
        }
      }
      return true
    },
  }
}
