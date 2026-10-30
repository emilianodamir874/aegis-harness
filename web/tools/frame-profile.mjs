#!/usr/bin/env node
/**
 * Set the frame profile on one Aegis chat, from the terminal.
 *
 * The web UI has no selector yet, so this is the per-session path until it does: it opens the same
 * ACP WebSocket the web uses, initializes, and calls the custom method. The profile is stored in the
 * session row, so it survives restarts and applies to every later turn of that chat.
 *
 *   node frame-profile.mjs <sessionId> [profile] [--url ws://127.0.0.1:3284/acp] [--token TOKEN]
 *
 * profile: work | fiction | synthetic | stacked   (default work, which clears it)
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    flags[args[i].slice(2)] = args[i + 1];
    i++;
  } else {
    rest.push(args[i]);
  }
}

const sessionId = rest[0];
const profile = rest[1] || "work";
if (!sessionId) {
  console.error("usage: node frame-profile.mjs <sessionId> [work|fiction|synthetic|stacked] [--url ...] [--token ...]");
  process.exit(2);
}

// The web keeps its token in config.json next to this script's project; fall back to nothing.
let token = flags.token;
if (!token) {
  for (const candidate of [
    path.join(process.cwd(), "config.json"),
    "C:/Aegis-Proyects/web/config.json",
  ]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      token = cfg.secretKey || cfg.token || "";
      if (token) break;
    } catch {
      /* keep looking */
    }
  }
}

const base = flags.url || "ws://127.0.0.1:3284/acp";
const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;

const ws = new WebSocket(url);
let id = 0;
const pending = new Map();

function call(method, params) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }
    }, 15000);
  });
}

ws.addEventListener("message", (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (msg.id == null || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(JSON.stringify(msg.error)));
  else resolve(msg.result);
});

ws.addEventListener("open", async () => {
  try {
    await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    await call("_aegis/unstable/session/frame-profile/set", {
      sessionId,
      profile,
    });
    console.log(`ok: session ${sessionId} -> ${profile}`);
    ws.close();
    process.exit(0);
  } catch (error) {
    console.error("failed:", error.message);
    ws.close();
    process.exit(1);
  }
});

ws.addEventListener("error", (event) => {
  console.error("websocket error:", event.message || event.type);
  process.exit(1);
});
