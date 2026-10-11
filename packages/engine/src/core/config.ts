// Engine configuration from environment variables (engine-config spec).
// Core reads its own variables; each backend adapter reads its own through a ConfigReader.
// All problems are collected and reported together, so operators fix them in one go.

import { accessSync, constants, readFileSync, statSync } from "node:fs";

export type Env = Readonly<Record<string, string | undefined>>;

/** One configuration problem, phrased for operators. */
export interface ConfigProblem {
  message: string;
}

/** Thrown by `loadConfig` when at least one problem was found. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly ConfigProblem[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p.message}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Reads a backend adapter's own variables, or reports what is wrong with them. */
export type ConfigReader<T> = (env: Env) => T | ConfigProblem[];

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ["pretty", "json"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export const WATCH_POLL_MODES = ["auto", "true", "false"] as const;
export type WatchPollMode = (typeof WATCH_POLL_MODES)[number];

export interface CoreConfig {
  rulesDir: string;
  dataDir: string;
  logLevel: LogLevel;
  logFormat: LogFormat;
  hotReload: boolean;
  watchPoll: WatchPollMode;
  /** Glob patterns on rule IDs. */
  disabledRules: string[];
  dryRun: boolean;
  /** IANA time zone; `undefined` means "take it from the backend". */
  timeZone: string | undefined;
  /** 0 disables the HTTP endpoints. */
  httpPort: number;
  npmInstall: boolean;
}

export interface LoadedConfig<B> {
  core: CoreConfig;
  backend: B;
}

export interface LoadConfigOptions {
  /** Checks that the rules directory exists and is readable; returns a problem message or undefined. */
  checkRulesDir?: (path: string) => string | undefined;
}

/**
 * Reads and validates the whole configuration. Throws `ConfigError` listing every problem.
 */
export function loadConfig<B>(
  env: Env,
  readBackend: ConfigReader<B>,
  options: LoadConfigOptions = {},
): LoadedConfig<B> {
  const problems: ConfigProblem[] = [];
  const core = readCoreConfig(env, problems);
  const backend = readBackend(env);
  if (Array.isArray(backend)) problems.push(...backend);

  const dirProblem = (options.checkRulesDir ?? checkReadableDir)(core.rulesDir);
  if (dirProblem) problems.push({ message: `RULES_DIR: ${dirProblem}` });

  if (problems.length > 0) throw new ConfigError(problems);
  return { core, backend: backend as B };
}

function readCoreConfig(env: Env, problems: ConfigProblem[]): CoreConfig {
  return {
    rulesDir: value(env, "RULES_DIR") ?? "/rules",
    dataDir: value(env, "DATA_DIR") ?? "/data",
    logLevel: oneOf(env, "LOG_LEVEL", LOG_LEVELS, "info", problems),
    logFormat: oneOf(env, "LOG_FORMAT", LOG_FORMATS, "pretty", problems),
    hotReload: bool(env, "HOT_RELOAD", true, problems),
    watchPoll: oneOf(env, "WATCH_POLL", WATCH_POLL_MODES, "auto", problems),
    disabledRules: list(env, "DISABLED_RULES"),
    dryRun: bool(env, "DRY_RUN", false, problems),
    timeZone: timeZone(env, problems),
    httpPort: port(env, "HTTP_PORT", 8080, problems),
    npmInstall: bool(env, "NPM_INSTALL", true, problems),
  };
}

/** The variable's value; empty strings count as unset (compose files often set `X=`). */
export function value(env: Env, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/**
 * Reads `name`, or the trimmed content of the file named by `<name>_FILE` (Docker/Kubernetes
 * secrets). Setting both is a problem.
 */
export function valueOrFile(env: Env, name: string, problems: ConfigProblem[]): string | undefined {
  const direct = value(env, name);
  const file = value(env, `${name}_FILE`);
  if (direct !== undefined && file !== undefined) {
    problems.push({ message: `${name} and ${name}_FILE are both set; set only one of them.` });
    return undefined;
  }
  if (file === undefined) return direct?.trim();
  try {
    const content = readFileSync(file, "utf8").trim();
    if (content === "") problems.push({ message: `${name}_FILE: file ${file} is empty.` });
    return content || undefined;
  } catch (err) {
    problems.push({ message: `${name}_FILE: cannot read ${file} (${errorCode(err)}).` });
    return undefined;
  }
}

function oneOf<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  fallback: T,
  problems: ConfigProblem[],
): T {
  const raw = value(env, name)?.trim().toLowerCase();
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  problems.push({
    message: `${name}: "${env[name]}" is not valid; use one of ${allowed.join(", ")}.`,
  });
  return fallback;
}

function bool(env: Env, name: string, fallback: boolean, problems: ConfigProblem[]): boolean {
  const raw = value(env, name)?.trim().toLowerCase();
  if (raw === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  problems.push({ message: `${name}: "${env[name]}" is not a boolean; use true or false.` });
  return fallback;
}

function list(env: Env, name: string): string[] {
  return (value(env, name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function port(env: Env, name: string, fallback: number, problems: ConfigProblem[]): number {
  const raw = value(env, name)?.trim();
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (/^\d+$/.test(raw) && n <= 65535) return n;
  problems.push({ message: `${name}: "${env[name]}" is not a port number (0-65535).` });
  return fallback;
}

function timeZone(env: Env, problems: ConfigProblem[]): string | undefined {
  const raw = value(env, "TIME_ZONE")?.trim();
  if (raw === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw });
    return raw;
  } catch {
    problems.push({ message: `TIME_ZONE: "${raw}" is not a known IANA time zone.` });
    return undefined;
  }
}

function checkReadableDir(path: string): string | undefined {
  try {
    if (!statSync(path).isDirectory()) return `${path} is not a directory.`;
    accessSync(path, constants.R_OK | constants.X_OK);
    return undefined;
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return `directory ${path} does not exist.`;
    if (code === "EACCES") return `directory ${path} is not readable.`;
    return `cannot access ${path} (${code}).`;
  }
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? String(err);
}

/** Keys whose values are never logged. */
const SECRET_KEY = /token|secret|password|api[-_]?key/i;
export const REDACTED = "***";

/** Deep copy of `value` with every secret-looking key's value replaced by `***`. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      SECRET_KEY.test(key) && v !== undefined ? REDACTED : redact(v),
    ]),
  );
}

/** The subset of a pino-style logger this module needs. */
export interface InfoLogger {
  info(obj: object, msg: string): void;
}

/** Logs the effective configuration at info level, with secrets redacted. */
export function logEffectiveConfig(log: InfoLogger, config: LoadedConfig<unknown>): void {
  log.info({ config: redact(config) }, "Effective configuration");
}
