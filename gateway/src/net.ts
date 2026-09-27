import type { IncomingMessage } from "node:http";

// Behind a reverse proxy / tunnel (e.g. cloudflared) every request arrives
// from the proxy's own address, so per-IP limits would lump all users into
// one bucket. TRUST_PROXY=1 makes us read the client IP the proxy reports
// instead - only set it when the gateway is reachable *solely* through that
// proxy, otherwise anyone can send the header and pick their own "IP".
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

export function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf.trim();
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

/** Sliding-window "N per window per key" limiter. Expired keys are swept
 *  periodically so the map can't grow without bound under a stream of
 *  one-shot IPs. */
export function createRateLimiter(limit: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= windowMs)) hits.delete(key);
    }
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length > limit;
  };
}
