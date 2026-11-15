/**
 * source-budget.ts — Per-source concurrency, time-budget and circuit-breaker layer.
 *
 * Wraps an existing {@link SearchSourceRegistry} without changing the source
 * implementations or the registry contract. For every source it enforces:
 * - a maximum number of concurrent in-flight calls (semaphore);
 * - a total wall-clock budget shared by every call in the batch;
 * - a circuit breaker that opens after a configurable number of consecutive
 *   failures, so a persistently failing source is skipped immediately instead
 *   of slowing every remaining input.
 *
 * Errors thrown by the wrapped source are propagated untouched so callers keep
 * normalizing them through the single `toSourceError` helper in `http.ts`.
 *
 * @module source-budget
 */

import type { SearchSource, SearchSourceRegistry, SourceBibtexContext, SourceSearchContext } from "./source.js";
import type { BibliographicCandidate } from "./ranking.js";
import type { BibtexRecord } from "./bibtex.js";
import type { PaperSource } from "./types.js";

/**
 * Knobs controlling how aggressively a single source is constrained.
 */
export interface SourceBudgetOptions {
  /** Maximum concurrent in-flight calls (search or BibTeX fetch) per source. */
  perSourceConcurrency: number;
  /** Total wall-clock budget in milliseconds available to each source. */
  perSourceBudgetMs: number;
  /** Consecutive call failures after which the source circuit opens. */
  failureThreshold: number;
}

/**
 * Runtime statistics collected for one source across the whole batch.
 */
export interface SourceBudgetStats {
  source: PaperSource;
  /** Calls that resolved successfully. */
  successCount: number;
  /** Attempted calls that rejected with an error (including timeouts). */
  failureCount: number;
  /** Calls never attempted because the budget was spent or the circuit was open. */
  skippedCount: number;
  /** Summed wall-clock milliseconds of all attempted calls. */
  totalElapsedMs: number;
  /** Whether the circuit breaker is currently open. */
  circuitOpen: boolean;
  /** Whether the wall-clock budget has been exhausted. */
  budgetExhausted: boolean;
}

/**
 * Error raised when a call is rejected before reaching the wrapped source,
 * either because the time budget is spent or the circuit breaker is open.
 */
export class SourceBudgetError extends Error {
  readonly source: PaperSource;
  readonly reason: "budget-exhausted" | "circuit-open";

  constructor(source: PaperSource, reason: SourceBudgetError["reason"], detail: string) {
    super(`Source ${source} unavailable (${reason}): ${detail}`);
    this.name = "SourceBudgetError";
    this.source = source;
    this.reason = reason;
  }
}

/**
 * Aggregated, snapshot view of every constrained source.
 */
export class SourceBudgetController {
  private readonly states = new Map<PaperSource, SourceBudgetState>();
  private readonly sourceOrder: PaperSource[] = [];

  constructor(private readonly options: SourceBudgetOptions) {}

  /** Lazily create (or fetch) the mutable state record for one source. */
  stateFor(source: PaperSource): SourceBudgetState {
    let state = this.states.get(source);
    if (!state) {
      state = new SourceBudgetState(source, this.options);
      this.states.set(source, state);
      this.sourceOrder.push(source);
    }
    return state;
  }

  /**
   * Snapshot statistics for every registered source, including sources that
   * were never reached (reported with zero counters).
   */
  stats(): SourceBudgetStats[] {
    return this.sourceOrder.map((source) => this.stateFor(source).snapshot());
  }
}

/**
 * Mutable per-source state: semaphore slots, lazy budget clock, failure streak.
 */
class SourceBudgetState {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private budgetStartedAt: number | undefined;
  private budgetElapsedMs = 0;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private budgetExhausted = false;
  private successCount = 0;
  private failureCount = 0;
  private skippedCount = 0;
  private totalElapsedMs = 0;

  constructor(
    private readonly source: PaperSource,
    private readonly options: SourceBudgetOptions
  ) {}

  snapshot(): SourceBudgetStats {
    return {
      source: this.source,
      successCount: this.successCount,
      failureCount: this.failureCount,
      skippedCount: this.skippedCount,
      totalElapsedMs: this.totalElapsedMs,
      circuitOpen: this.circuitOpen,
      budgetExhausted: this.budgetExhausted
    };
  }

  /**
   * Run one bounded call against this source.
   *
   * Rejects immediately with {@link SourceBudgetError} when the circuit is open
   * or the cumulative wall-clock budget is spent; otherwise acquires a
   * semaphore slot, times the call, and updates the success/failure counters.
   */
  async run<T>(call: () => Promise<T>): Promise<T> {
    if (this.circuitOpen) {
      this.skippedCount += 1;
      throw new SourceBudgetError(this.source, "circuit-open", `skipped after ${this.options.failureThreshold} consecutive failures`);
    }
    if (this.hasSpentBudget()) {
      this.budgetExhausted = true;
      this.skippedCount += 1;
      throw new SourceBudgetError(this.source, "budget-exhausted", `time budget of ${this.options.perSourceBudgetMs}ms exhausted`);
    }

    if (this.budgetStartedAt === undefined) {
      this.budgetStartedAt = Date.now();
    }
    await this.acquireSlot();
    const startedAt = Date.now();
    try {
      const result = await call();
      this.successCount += 1;
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.failureCount += 1;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.circuitOpen = true;
      }
      throw error;
    } finally {
      this.totalElapsedMs += Date.now() - startedAt;
      this.releaseSlot();
      if (this.hasSpentBudget()) {
        this.budgetExhausted = true;
      }
    }
  }

  private hasSpentBudget(): boolean {
    if (this.budgetStartedAt === undefined) {
      return false;
    }
    const inFlight = Date.now() - this.budgetStartedAt;
    return this.budgetElapsedMs + inFlight >= this.options.perSourceBudgetMs;
  }

  private acquireSlot(): Promise<void> {
    if (this.active < this.options.perSourceConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

/**
 * Wrap a registry so every source call passes through a shared budget controller.
 *
 * The returned map keeps the same keys as the base registry. Both `search()`
 * and the optional `fetchBibtex()` of each source are bounded.
 *
 * @param base - The original registry of concrete source implementations.
 * @param options - Concurrency, time-budget and circuit-breaker settings.
 * @returns The wrapped registry plus the controller that holds per-source stats.
 */
export function createBudgetedRegistry(
  base: SearchSourceRegistry,
  options: SourceBudgetOptions
): { registry: SearchSourceRegistry; controller: SourceBudgetController } {
  const controller = new SourceBudgetController(options);
  const wrapped: SearchSourceRegistry = new Map();

  for (const [name, source] of base) {
    const state = controller.stateFor(name);
    const boundedSource: SearchSource = {
      name,
      search: (context: SourceSearchContext) => state.run(() => source.search(context)),
      fetchBibtex: source.fetchBibtex
        ? (record: BibtexRecord, context: SourceBibtexContext) => state.run(() => source.fetchBibtex!(record, context))
        : undefined
    };
    wrapped.set(name, boundedSource);
  }

  return { registry: wrapped, controller };
}
