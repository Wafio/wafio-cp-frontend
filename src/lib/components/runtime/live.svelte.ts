/**
 * Live rows from the host stream, held back until the operator shows them so
 * a table never shifts under the pointer. Keyed and deduplicated.
 */
import { dedupeByKey, sortNewestFirst } from './explore';

export class LiveBuffer<T> {
  /** Rows received since the last take(), newest first. Reactive. */
  pending = $state.raw<T[]>([]);
  /** Rows received since the buffer was created or cleared. Reactive. */
  received = $state(0);

  #keyOf: (row: T) => string;
  #timeOf: (row: T) => string | null | undefined;
  #cap: number;
  #accept: (row: T) => boolean;

  constructor(keyOf: (row: T) => string, timeOf: (row: T) => string | null | undefined, opts: { cap?: number; accept?: (row: T) => boolean } = {}) {
    this.#keyOf = keyOf;
    this.#timeOf = timeOf;
    this.#cap = opts.cap ?? 1000;
    this.#accept = opts.accept ?? (() => true);
  }

  /** Adds a batch; the buffer keeps rows newest first, deduplicated, capped. */
  push(batch: readonly T[] | null | undefined): void {
    if (!batch?.length) return;
    const accepted = batch.filter(this.#accept);
    if (!accepted.length) return;
    this.pending = dedupeByKey(sortNewestFirst([...accepted, ...this.pending], this.#timeOf), this.#keyOf).slice(0, this.#cap);
    this.received += accepted.length;
  }

  /** Removes and returns the pending rows (newest first). */
  take(): T[] {
    const rows = this.pending;
    this.pending = [];
    return rows;
  }

  /** Changes the acceptance rule (e.g. rows recorded after a log clear). */
  setAccept(accept: (row: T) => boolean): void {
    this.#accept = accept;
    this.pending = this.pending.filter(accept);
  }

  clear(): void {
    this.pending = [];
    this.received = 0;
  }
}
