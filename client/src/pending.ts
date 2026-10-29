/**
 * Remember an uncertain placement in the current browser tab so retries reuse one bet ID.
 */
export type Pending = { betId: string; roundId: string; amount: number; autoCashout?: number };

/**
 * Restore the saved attempt on UI startup, or return null if reading/parsing fails.
 * Keep the older stored ID during field-name migration instead of generating another wager.
 */
export function readPending(storage: Pick<Storage, 'getItem'> = sessionStorage): Pending | null {
  try {
    const pending = JSON.parse(storage.getItem('pending-bet') ?? 'null');
    // Preserve the original bet ID when upgrading an unfinished bet saved by the old client.
    if (pending && !pending.betId && pending.requestId) {
      pending.betId = pending.requestId;
      delete pending.requestId;
    }
    return pending;
  } catch {
    return null;
  }
}
