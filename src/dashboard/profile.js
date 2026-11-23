"use strict";

const pkg = require("../../package.json");
const { loadConfig } = require("../config");
const { Driver } = require("../driver");

const STYLES = [
  "mapbox://styles/mapbox/light-v11",
  "mapbox://styles/mapbox/streets-v12",
  "mapbox://styles/mapbox/outdoors-v12",
  "mapbox://styles/mapbox/dark-v11",
  "mapbox://styles/mapbox/satellite-streets-v12",
];

/** What makes this dashboard the map driver's rather than the OSRM driver's. */
module.exports = {
  kind: "mapbox",
  title: "Mapbox map driver",
  packageName: pkg.name,
  version: pkg.version,

  settings: [
    {
      name: "SC_WS_URL",
      label: "Smart Checkpoints server",
      type: "server",
      default: "ws://localhost:3000/distance-driver",
      hint: "localhost:3000, an IP like 192.168.1.5:3000, or a full ws:// address.",
    },
    {
      name: "MAPBOX_TOKEN",
      label: "Mapbox access token",
      type: "secret",
      default: "",
      hint: "A public token (pk.…) from your Mapbox account. Reload the map view after changing it.",
    },
    {
      name: "MAPBOX_STYLE",
      label: "Map style",
      type: "text",
      default: "mapbox://styles/mapbox/light-v11",
      hint: "Any Mapbox style URL. Light matches the console.",
      options: STYLES,
    },
  ],

  envApiKey: (env) => env.SC_API_KEY || null,

  loadConfig: (env) => loadConfig(env, { dashboard: true }),

  createDriver: (config) => new Driver(config, { stopOnReject: true }),

  initialStats: () => ({}),

  track() {
    // A map driver answers nothing; its status is the whole story.
  },

  describe({ config, status }) {
    if (!config) return [];
    const rows = [{ label: "Map page", value: config.uiUrl, href: config.uiUrl, mono: true }];
    if (status.state === "connected") {
      rows.push({
        label: "In the console",
        value: "Approve this address under Project before the map view shows.",
        tone: "warn",
      });
    }
    if (!config.mapboxToken) {
      rows.push({ label: "Mapbox token", value: "Missing. Paste one in Settings.", tone: "bad" });
    } else if (!config.mapboxToken.startsWith("pk.")) {
      rows.push({
        label: "Mapbox token",
        value: "Set, but not a public pk. token. The browser needs a public one.",
        tone: "warn",
      });
    } else {
      rows.push({ label: "Mapbox token", value: `Set (…${config.mapboxToken.slice(-4)})`, tone: "good" });
    }
    rows.push({ label: "Style", value: config.mapboxStyle, mono: true });
    return rows;
  },
};
