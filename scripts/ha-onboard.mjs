#!/usr/bin/env node
// Onboards a fresh Home Assistant (owner user, core config, analytics, integration step) and
// prints a long-lived access token on stdout. For tests against a containerised instance:
//   node scripts/ha-onboard.mjs http://127.0.0.1:8123
// Waits up to 5 minutes for Home Assistant to come up.

const base = (process.argv[2] ?? "http://127.0.0.1:8123").replace(/\/+$/, "");
const clientId = `${base}/`;
const user = { name: "home-engine", username: "home-engine", password: "home-engine-test" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = "GET", token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (json) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = new URLSearchParams(form);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitForHomeAssistant() {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      return await request("/api/onboarding");
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(2000);
    }
  }
}

/** Creates a long-lived token over the WebSocket API. */
function longLivedToken(accessToken) {
  const url = `${base.replace(/^http/, "ws")}/api/websocket`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: accessToken }));
      } else if (msg.type === "auth_ok") {
        ws.send(
          JSON.stringify({
            id: 1,
            type: "auth/long_lived_access_token",
            client_name: "home-engine",
            lifespan: 3650,
          }),
        );
      } else if (msg.type === "auth_invalid") {
        reject(new Error("access token rejected"));
      } else if (msg.type === "result") {
        ws.close();
        if (msg.success) resolve(msg.result);
        else reject(new Error(msg.error?.message ?? "creating the token failed"));
      }
    });
  });
}

const steps = await waitForHomeAssistant();
const userStep = steps.find((s) => s.step === "user");
if (userStep?.done) throw new Error("Home Assistant is already onboarded");

const { auth_code: code } = await request("/api/onboarding/users", {
  method: "POST",
  json: { client_id: clientId, ...user, language: "en" },
});
const { access_token: accessToken } = await request("/auth/token", {
  method: "POST",
  form: { grant_type: "authorization_code", code, client_id: clientId },
});
await request("/api/onboarding/core_config", { method: "POST", token: accessToken });
await request("/api/onboarding/analytics", { method: "POST", token: accessToken });
await request("/api/onboarding/integration", {
  method: "POST",
  token: accessToken,
  json: { client_id: clientId, redirect_uri: `${base}/?auth_callback=1` },
});
process.stdout.write(`${await longLivedToken(accessToken)}\n`);
