export function createCharlotteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot(feed, { signal } = {}) {
      const response = await fetchImpl(
        `/api/charlotte?source=${encodeURIComponent(feed)}`,
        { signal },
      );
      const payload = await response.json();
      signal?.throwIfAborted();
      if (!response.ok)
        throw new Error(payload?.error || `Charlotte HTTP ${response.status}`);
      if (!Array.isArray(payload?.rows) || !Number.isFinite(payload.fetchedAt))
        throw new Error('Malformed Charlotte snapshot');
      return payload;
    },
  };
}
