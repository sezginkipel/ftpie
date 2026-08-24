/** Type declarations for the hand-rolled matchers in `setup.ts`. */
import 'vitest';

declare module 'vitest' {
  interface Assertion<T = unknown> {
    toBeInTheDocument(): T;
    toHaveAttribute(name: string, value?: string): T;
    toHaveTextContent(expected: string): T;
  }
  interface AsymmetricMatchersContaining {
    toBeInTheDocument(): void;
    toHaveAttribute(name: string, value?: string): void;
    toHaveTextContent(expected: string): void;
  }
}
