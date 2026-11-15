// Per-identity request budget (spec D14). ADO limits an identity to 200 TSTU per sliding five minutes and reports headers before
// delaying. We count calls, read X-RateLimit-Remaining when present, and park the identity on 429 or an explicit Retry-After.
export class RateGate {
  private calls: number[] = [];
  parkedUntil = 0;
  remainingHint: number | null = null;
  private readonly now: () => number;
  private readonly windowMs: number;
  constructor(now: () => number = Date.now, windowMs = 300_000) { this.now = now; this.windowMs = windowMs; }

  callsInWindow(): number {
    const cut = this.now() - this.windowMs;
    this.calls = this.calls.filter((t) => t > cut);
    return this.calls.length;
  }
  record(headers?: { get(name: string): string | null }): void {
    this.calls.push(this.now());
    if (!headers) return;
    const rem = Number(headers.get('x-ratelimit-remaining'));
    if (headers.get('x-ratelimit-remaining') !== null && Number.isFinite(rem)) this.remainingHint = rem;
    const ra = Number(headers.get('retry-after'));
    if (headers.get('retry-after') !== null && Number.isFinite(ra) && ra > 0) this.park(ra);
    const delay = Number(headers.get('x-ratelimit-delay'));
    if (headers.get('x-ratelimit-delay') !== null && Number.isFinite(delay) && delay >= 5) this.park(delay);
  }
  park(seconds: number): void { this.parkedUntil = Math.max(this.parkedUntil, this.now() + Math.min(seconds, 900) * 1000); }
  parkedSeconds(): number { return Math.max(0, Math.ceil((this.parkedUntil - this.now()) / 1000)); }
  /** True when the caller should not start more optional (reconciler) work. */
  lowBudget(floor = 40): boolean { return this.parkedSeconds() > 0 || (this.remainingHint !== null && this.remainingHint < floor); }
}
