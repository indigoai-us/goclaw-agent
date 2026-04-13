/**
 * Minimal logging utility.
 * Replaces @indigoai-us/goclaw-shared logError for standalone use.
 */

export function logError(opts: {
  module: string;
  errorType: string;
  message: string;
  stack?: string;
}): void {
  console.error(`[${opts.module}] ${opts.errorType}: ${opts.message}`);
  if (opts.stack) console.error(opts.stack);
}
