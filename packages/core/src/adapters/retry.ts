import {
  type AdapterResult,
  type ModelAdapter,
  UpstreamProviderError,
} from './base.js';

/**
 * Retry decorator that wraps a {@link ModelAdapter} and retries the underlying
 * `generate` call exactly once when the inner adapter throws an
 * {@link UpstreamProviderError} with a 5xx status. PAR-32 / PRD D2.
 *
 * Default behavior: retries are OFF. Callers opt in by constructing an
 * `Retrying5xxAdapter` around an existing adapter — typically gated on the
 * `transform.retry_on_upstream_500` request flag at the route layer.
 *
 * Intentionally narrow:
 *   - Only retries on `UpstreamProviderError` (i.e., the upstream returned a
 *     response we read; bare connection failures stay a single shot).
 *   - Only retries on HTTP 5xx — 4xx errors (auth, validation, model-not-found)
 *     are deterministic and pointless to retry.
 *   - Single retry only — multi-retry policies belong in a queue, not in the
 *     request path. Multiple sequential retries on a flaky upstream
 *     compound latency rather than improving reliability.
 *
 * Exponential backoff with jitter is overkill for a single retry; we use a
 * simple ~250ms sleep before the retry. This is enough to clear a stuck
 * connection without becoming user-visible.
 */
export class Retrying5xxAdapter implements ModelAdapter {
  readonly modelName: string;

  constructor(
    private readonly inner: ModelAdapter,
    private readonly retryDelayMs: number = 250,
  ) {
    this.modelName = inner.modelName;
  }

  async generate(prompt: string, system?: string): Promise<AdapterResult> {
    try {
      return await this.inner.generate(prompt, system);
    } catch (err) {
      if (
        err instanceof UpstreamProviderError &&
        err.upstream.status >= 500 &&
        err.upstream.status < 600
      ) {
        await sleep(this.retryDelayMs);
        return await this.inner.generate(prompt, system);
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
