/**
 * Controlled declaration for the pinned CommonJS runtime surface used by the
 * backup reader. The upstream 0.0.26 declarations do not compile under this
 * workspace's exactOptionalPropertyTypes setting.
 */
export declare class StreamingJsonParser {
  constructor(options: {
    readonly paths: string[];
    readonly stringBufferSize: number;
    readonly numberBufferSize: number;
  });

  readonly isEnded: boolean;
  set onValue(callback: (element: { readonly value?: unknown }) => void);
  write(input: Iterable<number> | string): void;
  end(): void;
}

export type StreamingJsonParserConstructor = typeof StreamingJsonParser;
