/**
 * An error that must stop the engine. Bootstrap logs it and exits with `exitCode`.
 * Everything else is isolated and logged, never fatal.
 */
export class FatalError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FatalError";
  }
}
