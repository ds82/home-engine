// Docker HEALTHCHECK: healthy while the engine's liveness endpoint answers 200.
const port = process.env.HTTP_PORT ?? "8080";
if (port === "0") {
  process.exit(0);
} // HTTP disabled: nothing to check.
try {
  const res = await fetch(`http://127.0.0.1:${port}/health/live`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
