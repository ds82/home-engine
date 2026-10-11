// Home Assistant connection settings: HA_URL / HA_TOKEN (each with a _FILE variant), or the
// Supervisor token when running as a Home Assistant add-on.

import { value, valueOrFile, type ConfigProblem, type Env } from "../../core/config.js";

export interface HomeAssistantConfig {
  /** HTTP base URL, e.g. `http://homeassistant.local:8123` (no trailing slash). */
  baseUrl: string;
  /** WebSocket API endpoint. */
  wsUrl: string;
  /** REST API base, e.g. `http://homeassistant.local:8123/api`. */
  restUrl: string;
  token: string;
  /** True when connecting through the Supervisor (add-on mode). */
  supervisor: boolean;
}

const SUPERVISOR_BASE = "http://supervisor/core";

export function readHomeAssistantConfig(env: Env): HomeAssistantConfig | ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const url = valueOrFile(env, "HA_URL", problems);
  const token = valueOrFile(env, "HA_TOKEN", problems);
  const supervisorToken = value(env, "SUPERVISOR_TOKEN")?.trim();

  // Explicit settings win; the Supervisor fills in whatever is not set explicitly.
  const useSupervisorUrl = url === undefined && supervisorToken !== undefined;
  const effectiveToken = token ?? supervisorToken;

  if (url === undefined && !useSupervisorUrl && !hasProblemFor(problems, "HA_URL")) {
    problems.push({ message: "HA_URL is required (or run as an add-on with SUPERVISOR_TOKEN)." });
  }
  if (effectiveToken === undefined && !hasProblemFor(problems, "HA_TOKEN")) {
    problems.push({
      message: "HA_TOKEN is required (or HA_TOKEN_FILE, or SUPERVISOR_TOKEN in add-on mode).",
    });
  }

  let endpoints: Pick<HomeAssistantConfig, "baseUrl" | "wsUrl" | "restUrl"> | undefined;
  if (useSupervisorUrl) {
    endpoints = {
      baseUrl: SUPERVISOR_BASE,
      wsUrl: "ws://supervisor/core/websocket",
      restUrl: `${SUPERVISOR_BASE}/api`,
    };
  } else if (url !== undefined) {
    endpoints = endpointsFromBaseUrl(url, problems);
  }

  if (problems.length > 0 || !endpoints || effectiveToken === undefined) return problems;
  return { ...endpoints, token: effectiveToken, supervisor: useSupervisorUrl };
}

/** `http(s)://host:port[/prefix]` → base, `ws(s)://host:port[/prefix]/api/websocket`, REST base. */
export function endpointsFromBaseUrl(
  url: string,
  problems: ConfigProblem[],
): Pick<HomeAssistantConfig, "baseUrl" | "wsUrl" | "restUrl"> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push({ message: `HA_URL: "${url}" is not a valid URL.` });
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    problems.push({
      message: `HA_URL: "${url}" must start with http:// or https:// (e.g. http://homeassistant.local:8123).`,
    });
    return undefined;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    problems.push({
      message: `HA_URL: "${url}" must not contain credentials, a query or a fragment.`,
    });
    return undefined;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const baseUrl = `${parsed.protocol}//${parsed.host}${path}`;
  const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return {
    baseUrl,
    wsUrl: `${wsProtocol}//${parsed.host}${path}/api/websocket`,
    restUrl: `${baseUrl}/api`,
  };
}

function hasProblemFor(problems: ConfigProblem[], name: string): boolean {
  return problems.some((p) => p.message.startsWith(name));
}
