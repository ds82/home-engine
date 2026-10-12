// Structured logging (engine-observability spec): pino with `json` or in-process `pretty`
// output. Every entry carries a `source`: "engine" or the rule ID of a per-rule child logger.
// Secrets are kept out twice: secret-looking keys are redacted by pino, and the known secret
// values (e.g. the access token) are scrubbed from the final output, wherever they appear.

import { Writable } from "node:stream";
import { pino, stdTimeFunctions, type DestinationStream, type Logger } from "pino";
import pretty from "pino-pretty";
import { REDACTED, type LogFormat, type LogLevel } from "./config.js";

export type { Logger } from "pino";

export const ENGINE_SOURCE = "engine";

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  /** Values that must never appear in any log line (tokens, passwords). */
  secrets?: readonly string[];
  /** Where formatted lines go. Default: stdout. */
  destination?: NodeJS.WritableStream;
  /** Colourise pretty output. Default: whether the destination is a TTY. */
  colorize?: boolean;
}

/** Keys redacted wherever pino can address them (top level and one or two levels down). */
const SECRET_KEYS = ["token", "access_token", "accessToken", "password", "secret", "apiKey"];
const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

export function createLogger(options: LoggerOptions): Logger {
  const target = options.destination ?? process.stdout;
  const scrubbed = scrubbingStream(target, options.secrets ?? []);
  const colorize = options.colorize ?? Boolean((target as { isTTY?: boolean }).isTTY);

  const stream: DestinationStream =
    options.format === "pretty"
      ? pretty({
          destination: scrubbed,
          sync: true,
          colorize,
          messageKey: "message",
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
          ignore: "pid,hostname,source",
          messageFormat: "[{source}] {message}",
        })
      : scrubbed;

  return pino(
    {
      level: options.level,
      // No pid/hostname. Lines get `source: "engine"` unless a child logger (a rule's) has its
      // own source; a base binding would put a second `source` key into those lines.
      base: null,
      mixin: (_object, _level, logger) =>
        "source" in logger.bindings() ? {} : { source: ENGINE_SOURCE },
      messageKey: "message",
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: REDACTED },
    },
    stream,
  );
}

/** Logger whose entries are tagged with the rule ID as their source. */
export function ruleLogger(parent: Logger, ruleId: string): Logger {
  return parent.child({ source: ruleId });
}

/** Writes through to `target`, replacing every occurrence of a secret with `***`. */
function scrubbingStream(target: NodeJS.WritableStream, secrets: readonly string[]): Writable {
  // Longest first, so a secret that contains another one is replaced as a whole.
  const values = [...new Set(secrets.filter((s) => s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      let line = chunk.toString();
      for (const secret of values) {
        line = line.replaceAll(secret, REDACTED);
      }
      target.write(line);
      callback();
    },
  });
}
