import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

// This suite is entirely offline, including unexpected regression paths.
globalThis.fetch = async () => { throw new Error("Real network is forbidden in relay tests"); };

const sharedSecret = "relay-test-secret";
const encoded = value => Buffer.from(value, "utf8").toString("base64url");
const form = values => new URLSearchParams(values).toString();
const request = (path, values) => new Request(`https://relay.example${path}`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: form(values),
});

test("health endpoint is public and versioned", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "football-ai-lab-telegram-relay",
    version: "cloudflare-relay-v2-secrets-only",
  });
});

test("unsigned Telegram request is rejected", async () => {
  const response = await worker.fetch(request("/api/telegram/send", {
    chat_id: "1", text: "test",
  }), { RELAY_SHARED_SECRET: sharedSecret, TELEGRAM_BOT_TOKEN: "worker-token" });
  assert.equal(response.status, 401);
});

test("send request forwards only Telegram fields and returns message_id", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url, options };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 321 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(request("/api/telegram/send", {
      chat_id: "42",
      text: "signal",
      parse_mode: "HTML",
      disable_web_page_preview: "true",
      _relay_key_b64: encoded(sharedSecret),
      _relay_bot_token_b64: encoded("body-token"),
    }), {
      RELAY_SHARED_SECRET: sharedSecret,
      TELEGRAM_BOT_TOKEN: "worker-token",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { message_id: 321 } });
    assert.match(forwarded.url, /botworker-token\/sendMessage$/);
    const forwardedForm = new URLSearchParams(forwarded.options.body);
    assert.equal(forwardedForm.get("chat_id"), "42");
    assert.equal(forwardedForm.get("text"), "signal");
    assert.equal(forwardedForm.has("_relay_key_b64"), false);
    assert.equal(forwardedForm.has("_relay_bot_token_b64"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("edit request uses editMessageText and keeps message_id", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (url, options) => {
    forwarded = { url, options };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(request("/api/telegram/edit", {
      chat_id: "42",
      text: "updated",
      message_id: "77",
      _relay_key_b64: encoded(sharedSecret),
    }), {
      RELAY_SHARED_SECRET: sharedSecret,
      TELEGRAM_BOT_TOKEN: "worker-token",
    });
    assert.equal(response.status, 200);
    assert.match(forwarded.url, /botworker-token\/editMessageText$/);
    assert.equal(new URLSearchParams(forwarded.options.body).get("message_id"), "77");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy body token cannot replace missing protected bot token", async () => {
  const originalFetch = globalThis.fetch;
  let forwardedUrl = "";
  globalThis.fetch = async (url) => {
    forwardedUrl = url;
    return new Response(JSON.stringify({ ok: false, error_code: 400 }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const response = await worker.fetch(request("/api/telegram/send", {
      chat_id: "1",
      text: "test",
      _relay_key_b64: encoded(sharedSecret),
      _relay_bot_token_b64: encoded("invalid"),
    }), { RELAY_SHARED_SECRET: sharedSecret });
    assert.equal(response.status, 503);
    assert.equal(forwardedUrl, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const configured = { RELAY_SHARED_SECRET: sharedSecret, TELEGRAM_BOT_TOKEN: "worker-token" };
const valid = { chat_id: "42", text: "test", _relay_key_b64: encoded(sharedSecret) };

async function noOutbound(action, expected) {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("outbound must not occur"); };
  try {
    const response = await action();
    assert.equal(response.status, expected);
    assert.equal(calls, 0);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response;
  } finally { globalThis.fetch = previous; }
}

for (const [label, env] of [
  ["missing environment", undefined], ["empty environment", {}],
  ["missing shared secret", { TELEGRAM_BOT_TOKEN: "worker-token" }],
  ["blank shared secret", { ...configured, RELAY_SHARED_SECRET: "   " }],
  ["non-string shared secret", { ...configured, RELAY_SHARED_SECRET: 123 }],
  ["blank bot token", { ...configured, TELEGRAM_BOT_TOKEN: "  " }],
  ["non-string bot token", { ...configured, TELEGRAM_BOT_TOKEN: {} }],
]) {
  test(`${label} fails closed`, async () => {
    await noOutbound(() => worker.fetch(request("/api/telegram/send", valid), env), 503);
  });
}

for (const [label, key] of [["old", encoded("retired-synthetic-secret")], ["malformed", "%%%"], ["empty", ""]]) {
  test(`${label} key does not authorize a send`, async () => {
    await noOutbound(() => worker.fetch(request("/api/telegram/send", { ...valid, _relay_key_b64: key }), configured), 401);
  });
}

test("request missing required Telegram fields is rejected", async () => {
  await noOutbound(() => worker.fetch(request("/api/telegram/send", { ...valid, text: "" }), configured), 400);
});

test("edit without message id never becomes a new send", async () => {
  await noOutbound(() => worker.fetch(request("/api/telegram/edit", valid), configured), 400);
});

test("untrusted content length does not bypass streamed byte limit", async () => {
  const req = new Request("https://relay.example/api/telegram/send", {
    method: "POST", headers: { "content-length": "1" }, body: "x".repeat(65537),
  });
  await noOutbound(() => worker.fetch(req, configured), 413);
});

test("oversized chunked body cancels before reading the whole stream", async () => {
  let canceled = false;
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(32768)); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  const req = new Request("https://relay.example/api/telegram/send", { method: "POST", body, duplex: "half" });
  await noOutbound(() => worker.fetch(req, configured), 413);
  assert.equal(canceled, true);
  assert.ok(reads <= 3);
});

test("invalid UTF-8 is rejected without outbound request", async () => {
  const req = new Request("https://relay.example/api/telegram/send", { method: "POST", body: new Uint8Array([0xff]) });
  await noOutbound(() => worker.fetch(req, configured), 400);
});

test("unsupported routes and methods do not forward", async () => {
  await noOutbound(() => worker.fetch(request("/unknown", valid), configured), 404);
  await noOutbound(() => worker.fetch(new Request("https://relay.example/api/telegram/send"), configured), 404);
});

test("uncertain upstream result is not automatically retried", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("synthetic lost acknowledgement"); };
  try {
    const response = await worker.fetch(request("/api/telegram/send", valid), configured);
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});
