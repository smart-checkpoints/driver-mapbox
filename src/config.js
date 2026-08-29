"use strict";

require("dotenv").config({ override: false, quiet: true });
const pkg = require("../package.json");

const DEFAULT_WS_URL = "ws://localhost:3000/distance-driver";
const DEFAULT_STYLE = "mapbox://styles/mapbox/light-v11";
const DEFAULT_PORT = 4100;

/**
 * Loopback by default, for the same reason the server is.
 *
 * This process serves a page that carries a Mapbox token, and it answers to
 * anything that can reach it. Opening it to a network should be a decision
 * somebody made rather than what happens when nobody sets a variable.
 */
const DEFAULT_HOST = "127.0.0.1";

function requiredEnv(source, name) {
  const value = source[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveIntEnv(source, name, fallback) {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * The address this driver announces to the server.
 *
 * It is the address an *operator's browser* has to be able to reach, which is
 * not necessarily the one this process binds to: a driver on another machine
 * binds to its own interface and is reached by hostname. Getting this wrong
 * produces a map view that will not load, so it is a variable rather than a
 * guess whenever the bind address is not the whole story.
 */
function publicUrl(source, host, port) {
  const declared = source.SC_MAP_PUBLIC_URL;
  if (declared) {
    const parsed = new URL(declared);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `SC_MAP_PUBLIC_URL must be an http(s) URL, got "${declared}"`,
      );
    }
    // The console compares the whole address against what it approved, so the
    // announced one has to be stable. A trailing slash is the difference
    // between two approvals of the same page.
    return parsed.toString();
  }
  const reachable = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${reachable}:${port}/`;
}

function loadConfig(source = process.env) {
  const wsUrl = source.SC_WS_URL || DEFAULT_WS_URL;

  const parsed = new URL(wsUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`SC_WS_URL must be a ws:// or wss:// URL, got "${wsUrl}"`);
  }

  const port = positiveIntEnv(source, "SC_MAP_PORT", DEFAULT_PORT);
  const host = source.SC_MAP_HOST || DEFAULT_HOST;

  return {
    driverName: pkg.name,
    driverVersion: pkg.version,
    wsUrl,
    apiKey: requiredEnv(source, "SC_API_KEY"),
    host,
    port,
    uiUrl: publicUrl(source, host, port),
    // Read from the environment and never committed. It reaches the browser
    // through /env.js, because a Mapbox token is a browser credential; it is
    // scoped and rotatable at Mapbox, and this process hands it only to
    // whoever can already reach this port.
    mapboxToken: requiredEnv(source, "MAPBOX_TOKEN"),
    mapboxStyle: source.MAPBOX_STYLE || DEFAULT_STYLE,
  };
}

module.exports = { loadConfig };
