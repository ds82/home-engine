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

/**
 * An error as shown in status output: `ReferenceError: foo is not defined`. The name is left
 * out for a plain `Error` and when the message already starts with it; anything thrown that
 * is not an Error is converted with String().
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const { name, message } = err;
  if (!name || name === "Error" || message.startsWith(name)) {
    return message;
  }
  return message ? `${name}: ${message}` : name;
}
