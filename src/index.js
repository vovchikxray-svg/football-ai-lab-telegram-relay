const VERSION = "cloudflare-relay-v1";
const MAX_BODY_BYTES = 64 * 1024;
const SEND_PATH = "/api/telegram/send";
const EDIT_PATH = "/api/telegram/edit";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
}

async function secureEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    sha256Bytes(String(left || "")),
    sha256Bytes(String(right || "")),
  ]);
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

function telegramMethod(pathname) {
  if (pathname === SEND_PATH) return "sendMessage";
  if (pathname === EDIT_PATH) return "editMessageText";
  return null;
}

function telegramForm(source, method) {
  const output = new URLSearchParams();
  for (const field of ["chat_id", "text", "parse_mode", "disable_web_page_preview"]) {
    const value = source.get(field);
    if (value !== null && value !== "") output.set(field, value);
  }
  if (method === "editMessageText") {
    const messageId = source.get("message_id");
    if (messageId !== null && messageId !== "") output.set("message_id", messageId);
  }
  return output;
}

async function handleTelegram(request, env, method) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }
  const form = new URLSearchParams(rawBody);
  let suppliedSecret = "";
  try {
    suppliedSecret = decodeBase64Url(form.get("_relay_key_b64"));
  } catch {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.RELAY_SHARED_SECRET || !await secureEqual(suppliedSecret, env.RELAY_SHARED_SECRET)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let botToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!botToken) {
    try {
      botToken = decodeBase64Url(form.get("_relay_bot_token_b64")).trim();
    } catch {
      botToken = "";
    }
  }
  const telegramBody = telegramForm(form, method);
  if (!botToken || !telegramBody.get("chat_id") || !telegramBody.get("text")) {
    return jsonResponse({ ok: false, error: "invalid_request" }, 400);
  }
  if (method === "editMessageText" && !telegramBody.get("message_id")) {
    return jsonResponse({ ok: false, error: "message_id_required" }, 400);
  }

  const safeToken = encodeURIComponent(botToken).replace(/%3A/gi, ":");
  let telegramResponse;
  try {
    telegramResponse = await fetch(
      `https://api.telegram.org/bot${safeToken}/${method}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "football-ai-lab-cloudflare-relay/1",
        },
        body: telegramBody.toString(),
      },
    );
  } catch {
    return jsonResponse({ ok: false, error: "telegram_unreachable" }, 502);
  }
  const responseText = await telegramResponse.text();
  return new Response(responseText, {
    status: telegramResponse.status,
    headers: {
      "content-type": telegramResponse.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "football-ai-lab-telegram-relay", version: VERSION });
    }
    const method = telegramMethod(url.pathname);
    if (request.method !== "POST" || !method) {
      return jsonResponse({ ok: false, error: "not_found" }, 404);
    }
    return handleTelegram(request, env, method);
  },
};

