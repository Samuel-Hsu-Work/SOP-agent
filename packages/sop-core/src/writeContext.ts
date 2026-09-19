/**
 * Node and browsers both provide a global `crypto`, but this package is type-checked with neither
 * the DOM nor the Node library, so it declares the one function it uses.
 */
declare const crypto: { randomUUID(): string };

/**
 * The clock and the id generator, injected so unit tests are deterministic without stubbing
 * globals.
 */
export interface WriteContext {
  now(): string;
  newId(): string;
}

export const systemWriteContext: WriteContext = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
};
