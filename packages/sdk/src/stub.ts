/** Runtime stub: the engine replaces this package with its own implementation. */
export function notInEngine(name: string): never {
  throw new Error(
    `${name}() is provided by home-engine at runtime; this package only contains types.`,
  );
}
