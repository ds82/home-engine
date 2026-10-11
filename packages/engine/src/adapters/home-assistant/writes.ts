// Writes to Home Assistant (ha-actions: Call services, Service response data, Unawaited
// write errors are reported). Every write is attributed to the calling rule (change cause,
// logs) and registered with the safety net, so a failing write nobody awaited is logged as
// a failed write of that rule instead of an anonymous unhandled rejection.

import { currentRun } from "../../core/run-context.js";
import { trackWrite } from "../../core/safety-net.js";
import type { Logger } from "../../core/logger.js";
import { trackedServiceCall } from "./attribution.js";
import type { HaClient } from "./client.js";
import { HaCommandError, HaDisconnectedError } from "./session.js";

export interface ServiceTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
  label_id?: string | string[];
}

export interface CallOptions {
  /** Ask the service for response data and resolve with it. */
  returnResponse?: boolean;
}

/** A write failed in Home Assistant; carries its error code. */
export class ServiceCallError extends Error {
  constructor(
    readonly service: string,
    readonly code: string,
    readonly haMessage: string,
  ) {
    super(`${service} failed: ${haMessage} (${code})`);
    this.name = "ServiceCallError";
  }
}

/** The engine is not connected to Home Assistant; writes are not queued. */
export class NotConnectedError extends Error {
  constructor(what: string) {
    super(`${what}: not connected to Home Assistant`);
    this.name = "NotConnectedError";
  }
}

const SERVICE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export interface Writes {
  call(
    service: string,
    data?: Record<string, unknown>,
    target?: ServiceTarget,
    options?: CallOptions,
  ): Promise<unknown>;
}

export function createWrites(client: HaClient, log: Logger): Writes {
  /** The calling rule (or "-" outside rule code) and its logger. */
  const caller = (): { ruleId: string; log: Logger } => {
    const run = currentRun();
    return run ? { ruleId: run.scope.ruleId, log: run.scope.log } : { ruleId: "-", log };
  };

  function call(
    service: string,
    data: Record<string, unknown> = {},
    target?: ServiceTarget,
    options: CallOptions = {},
  ): Promise<unknown> {
    if (typeof service !== "string" || !SERVICE.test(service)) {
      throw new TypeError(
        `call(): ${JSON.stringify(service)} is not a service name like "light.turn_on"`,
      );
    }
    const [domain = "", name = ""] = service.split(".");
    const { ruleId, log: ruleLog } = caller();
    const description = `${service}${target?.entity_id ? ` → ${[target.entity_id].flat().join(", ")}` : ""}`;

    const promise = (async () => {
      const session = client.connection.current;
      if (!session || !client.isReady) throw new NotConnectedError(service);
      ruleLog.debug({ service, target, data }, `Calling ${description}`);
      try {
        const result = await trackedServiceCall(client.attribution, session, ruleId, {
          domain,
          service: name,
          service_data: data,
          ...(target ? { target: target as Record<string, unknown> } : {}),
          ...(options.returnResponse ? { return_response: true } : {}),
        });
        return options.returnResponse ? result.response : undefined;
      } catch (err) {
        if (err instanceof HaCommandError)
          throw new ServiceCallError(service, err.code, haMessage(err));
        if (err instanceof HaDisconnectedError) throw new NotConnectedError(service);
        throw err;
      }
    })();
    return trackWrite(promise, description);
  }

  return { call };
}

/** Home Assistant's own message, without the session's "<command> failed:" prefix. */
function haMessage(err: HaCommandError): string {
  return err.message.replace(/^\S+ failed: /, "").replace(/ \([^)]*\)$/, "");
}
