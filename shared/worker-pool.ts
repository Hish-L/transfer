// Fixed-slot pool of decode workers.
//
// The subtle part is slot identity: every worker's message handler closes over
// its own index, so growing and shrinking the pool has to leave the surviving
// workers' indices alone. Shrinking from the end is what makes that true, and
// it is why this is worth having on its own rather than inline in the receiver.
//
// Each worker holds its own ~940 KB zxing WASM instance, so the pool is also
// how the receiver reclaims that memory the moment the last frame is in.

export interface PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

interface DecodeMessage {
  id: number;
  bytes: Uint8Array | null;
}

export class DecodeWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly busy: boolean[] = [];

  constructor(
    private readonly create: () => PoolWorker,
    private readonly onDecoded: (bytes: Uint8Array) => void,
  ) {}

  get size(): number {
    return this.workers.length;
  }

  get busyCount(): number {
    return this.busy.filter(Boolean).length;
  }

  /** Grow or shrink in place. Terminating a busy worker just drops the frame it
   *  held, which the fountain absorbs like any other miss. */
  resize(count: number): void {
    while (this.workers.length > Math.max(0, count)) {
      this.workers.pop()!.terminate();
      this.busy.pop();
    }
    while (this.workers.length < count) {
      const slot = this.workers.length;
      const worker = this.create();
      worker.onmessage = (event: MessageEvent) => {
        const { id, bytes } = event.data as DecodeMessage;
        if (id === -1) return; // warm-up ping, no frame attached
        this.busy[slot] = false;
        if (bytes) this.onDecoded(bytes);
      };
      this.workers.push(worker);
      this.busy.push(false);
    }
  }

  /** Hand a frame to a free worker. False when every worker is busy — the
   *  caller drops the frame rather than queueing it, because a stale frame is
   *  worth less than the next one. */
  submit(message: unknown, transfer: Transferable[]): boolean {
    const slot = this.busy.indexOf(false);
    if (slot === -1) return false;
    this.busy[slot] = true;
    this.workers[slot]!.postMessage(message, transfer);
    return true;
  }
}
