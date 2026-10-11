// A trace-level JSON logger that captures its output, for asserting on log lines.

import { Writable } from "node:stream";
import { createLogger, type Logger } from "../logger.js";

export const TOKEN = "eyJ0eXAiOiJKV1Qi.long-lived-token-abc123";

export interface LogCapture {
  log: Logger;
  text: () => string;
  entries: () => Array<Record<string, unknown>>;
}

export function logCapture(secrets: string[] = [TOKEN]): LogCapture {
  let out = "";
  const destination = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      out += chunk.toString();
      callback();
    },
  });
  const log = createLogger({ level: "trace", format: "json", secrets, destination });
  return {
    log,
    text: () => out,
    entries: () =>
      out
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
