/** Complete UTF-8 JSON byte ceiling for the Custom GPT transport only. */
export const customGptMaximumPayloadBytes = 99_999;

/** Distinguishes an unrepresentable complete read result from transient failures. */
export class CustomGptResponseTooLargeError extends Error {
  readonly maximumBytes: number;
  /**
   * Records the effective limit without retaining any result data.
   * @param maximumBytes - Validated route limit, possibly stricter than the hard ceiling.
   */
  constructor(maximumBytes: number) {
    super("Custom GPT read response exceeds its byte limit");
    this.name = "CustomGptResponseTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

/**
 * Rejects an entire serialized result before any success bytes are sent.
 * @param output - Validated JSON-compatible read result.
 * @param maximumBytes - Effective route limit, never above the hard ceiling.
 * @returns Nothing when the complete result fits; otherwise throws a capacity error.
 */
export function assertCustomGptResponseFits(output: unknown, maximumBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > maximumBytes) {
    throw new CustomGptResponseTooLargeError(maximumBytes);
  }
}
