import "server-only";

/**
 * P8-13 — per-transport send pacing.
 *
 * EVERY transactional ESP rate-limits, and this system's busiest caller is a
 * loop: `dispatchPendingEmails` drains up to fifty outbox rows in one pass,
 * sequentially, awaiting each send. Sequential is not the same as slow enough —
 * a send that resolves in 80ms puts twelve requests into a second — so the
 * spacing has to be deliberate rather than incidental.
 *
 * ⚠️ THIS WAS THE MIGRATION HAZARD IN P8-13, and it is why the pacer outlived
 * the transport it was written for. It lived inside the EmailJS adapter, so
 * switching to Resend would have moved the whole system onto a transport with
 * NO throttle at all — discovered as a burst of 429s on the first busy cron
 * tick, against outbox rows already marked as claimed. Hoisting it here made
 * "the adapter is paced" a property of being an adapter rather than a thing the
 * last one happened to do.
 *
 * P8-16 left it a module with one caller, which is the right shape rather than
 * an accident: an adapter builds its OWN pacer because rate limits are per
 * account, and a second transport would need its own interval rather than a
 * share of this one's.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a function that runs work no more often than `minIntervalMs`.
 *
 * In-process only, which is the honest scope: two Vercel lambdas serving the
 * same cron would each keep their own count. The drain is sequential inside one
 * invocation and that is the case this exists for; a distributed limiter would
 * need shared state and is not worth it until the outbox is a real queue.
 */
export function createPacer(minIntervalMs: number): <T>(work: () => Promise<T>) => Promise<T> {
  /** When the last request left, as `Date.now()`. Zero means "none yet". */
  let lastSendAt = 0;

  /**
   * The tail of the queue. Every send chains onto it, so two concurrent callers
   * are serialised rather than racing — without this both would read the same
   * `lastSendAt`, both would decide they could go, and both would go at once.
   */
  let queue: Promise<unknown> = Promise.resolve();

  return function paced<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(async () => {
      const wait = minIntervalMs - (Date.now() - lastSendAt);
      if (lastSendAt > 0 && wait > 0) await sleep(wait);

      // Stamped BEFORE the request, not after. The limit is on when a request
      // arrives, so a slow send must not be paid for twice.
      lastSendAt = Date.now();
      return work();
    });

    // The queue must never become a rejected promise, or every subsequent send
    // inherits the failure. `work()` does not reject — every adapter maps its
    // own failures to an outcome — but the queue is the one place where being
    // wrong about that is permanent.
    queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  };
}

/**
 * Runs `work`, or gives up on it after `ms` and returns `onTimeout()`.
 *
 * A third-party HTTP call with no timeout inside a server action holds the
 * user's response open for as long as the other end feels like taking, and
 * `/api/cron/dispatch-emails` has `maxDuration = 60` for a whole sweep — one
 * hung send must not be allowed to eat it.
 *
 * ⚠️ THIS ABANDONS, IT DOES NOT CANCEL. A bare `fetch` would take an
 * `AbortSignal`; the Resend SDK exposes no such hook, so the request carries on
 * in the background and its result is dropped. That is acceptable
 * precisely here and nowhere else: the send either happened or it did not, the
 * outbox row is already claimed either way, and the alternative is a stalled
 * cron.
 */
export async function withTimeout<T>(
  ms: number,
  work: () => Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });

  try {
    return await Promise.race([work(), expiry]);
  } finally {
    // Without this the lambda stays alive until the timer fires, on every send.
    if (timer) clearTimeout(timer);
  }
}
