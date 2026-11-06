// Thin HTTP clients for Anthropic (Claude), Square and Cloudflare. Keys come from Secret
// Manager at runtime and are never logged or sent to the browser.

import { randomUUID } from "node:crypto";
import {
  ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, SQUARE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_BASE_URL, squareBase,
} from "./config.js";

export class ApiError extends Error {
  constructor(service, status, detail) {
    super(`${service} ${status}: ${detail}`.slice(0, 500));
    this.service = service;
    this.status = status;
    this.detail = detail;
  }
}

async function call(service, url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    const raw = await r.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw: raw.slice(0, 300) }; }
    return { status: r.status, ok: r.ok, body };
  } catch (err) {
    throw new ApiError(service, 0, err.name === "AbortError" ? "timed out" : String(err.message || err));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Claude ----------
export async function claude({ model, system, messages, maxTokens = 16000, timeoutMs = 280_000 }) {
  const r = await call("anthropic", `${ANTHROPIC_BASE_URL.value()}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, system, messages, max_tokens: maxTokens }),
  }, timeoutMs);
  if (!r.ok) throw new ApiError("anthropic", r.status, r.body?.error?.message || "request failed");
  const textOut = (r.body?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  return { text: textOut, stop: r.body?.stop_reason, usage: r.body?.usage || {} };
}

// ---------- Square ----------
export async function square(method, path, body, timeoutMs = 30_000) {
  const r = await call("square", `${squareBase()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${SQUARE_ACCESS_TOKEN.value()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, timeoutMs);
  if (!r.ok) {
    const e = r.body?.errors?.[0];
    throw new ApiError("square", r.status, e ? `${e.code}: ${e.detail || e.category}` : "request failed");
  }
  return r.body || {};
}
export const idem = (prefix) => `${prefix}-${randomUUID()}`.slice(0, 45);

// ---------- Cloudflare ----------
const cfUrl = (path) => `${CLOUDFLARE_BASE_URL.value()}${path.replace("{account}", CLOUDFLARE_ACCOUNT_ID.value())}`;

export async function cf(method, path, body, { timeoutMs = 30_000, headers = {}, raw = false, allow = [] } = {}) {
  const r = await call("cloudflare", cfUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN.value()}`,
      ...(raw ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body == null ? undefined : raw ? body : JSON.stringify(body),
  }, timeoutMs);
  if (!r.ok && !allow.includes(r.status)) {
    const e = r.body?.errors?.[0];
    throw new ApiError("cloudflare", r.status, e ? `${e.code}: ${e.message}` : "request failed");
  }
  return { status: r.status, body: r.body || {} };
}
