"use strict";

const path = require("path");

const log = require("./logger");
const { loadConfig } = require("./config");
const { Driver } = require("./driver");
const { createHttpServer } = require("./http");

const pkg = require("../package.json");

/**
 * Two ways to run.
 *
 * By default a dashboard opens in the browser, at /dashboard on the same port
 * as the map page: it asks which project to serve, remembers keys, and
 * switches between projects without a restart.
 *
 * SC_DASHBOARD=off is the old behaviour, for a service manager or a server
 * with no browser: the key and token come from .env, and a second copy of the
 * driver holding the slot makes this one exit non-zero.
 */
const dashboardOff = /^(0|off|false|no)$/i.test(process.env.SC_DASHBOARD || "");

process.on("unhandledRejection", (reason) => {
  log.error(`unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on("uncaughtException", (err) => {
  log.error(`uncaught exception: ${err.stack || err.message}`);
});

if (dashboardOff) runHeadless();
else void runWithDashboard();

function configOrExit(options) {
  try {
    return loadConfig(process.env, options);
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    console.error("See .env.example for the variables this driver reads.");
    process.exit(1);
  }
}

function listenOrExit(site, where) {
  return site.start().catch((err) => {
    console.error(`Cannot serve ${where}: ${err.message}`);
    if (err.code === "EADDRINUSE") {
      console.error(
        "Another program, perhaps another copy of this driver, holds that port. " +
          "Stop it, or set SC_MAP_PORT to a free one.",
      );
    }
    process.exit(1);
  });
}

function runHeadless() {
  const config = configOrExit();

  log.setTag(`${config.driverName}/${config.driverVersion}`);
  log.info(`starting: server=${config.wsUrl} ui=${config.uiUrl} style=${config.mapboxStyle}`);

  const site = createHttpServer(config);

  // Some things reconnecting cannot fix. A second copy of this driver holding
  // the project's map slot is one of them, and the useful response is to stop
  // with a non-zero exit code so whatever started this one notices.
  const driver = new Driver(config, {
    onFatal: () => {
      site.stop();
      process.exit(1);
    },
  });

  // The page is served before the socket is opened, so that an operator who
  // approves the announced address the moment it appears finds something at it.
  void listenOrExit(site, "the map page").then(() => driver.start());

  onShutdown(() => {
    driver.stop();
    site.stop();
  });
}

async function runWithDashboard() {
  const { Store } = require("./dashboard/store");
  const { Controller } = require("./dashboard/controller");
  const {
    createDashboardHandler,
    startStandaloneDashboard,
    PREFIX,
  } = require("./dashboard/http");
  const { openBrowser } = require("./dashboard/open-browser");
  const profile = require("./dashboard/profile");

  log.setTag(`${pkg.name}/${pkg.version}`);

  const base = configOrExit({ dashboard: true });
  const store = new Store(
    path.resolve(process.env.SC_DASHBOARD_FILE || path.join(__dirname, "..", "projects.json")),
  );
  const controller = new Controller({ profile, store });

  // The dashboard answers loopback only. When the map page is bound to one
  // specific network address, loopback cannot reach it there, so the
  // dashboard gets a port of its own on 127.0.0.1 instead.
  const reachableOnLoopback = ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(
    base.host,
  );

  const site = createHttpServer(() => controller.currentConfig() || base, {
    handle: reachableOnLoopback ? createDashboardHandler(controller) : undefined,
  });
  await listenOrExit(site, "the map page");

  let url = `http://127.0.0.1:${base.port}${PREFIX}/`;
  let standalone = null;
  if (!reachableOnLoopback) {
    const port = Number.parseInt(process.env.SC_DASHBOARD_PORT || "", 10) || 4201;
    standalone = await startStandaloneDashboard(controller, { host: "127.0.0.1", port });
    url = `http://127.0.0.1:${standalone.port}${PREFIX}/`;
  }
  controller.dashboardUrl = url;
  log.info(`dashboard: ${url}`);

  await controller.start();

  if (!/^(0|off|false|no)$/i.test(process.env.SC_DASHBOARD_OPEN || "")) openBrowser(url);

  onShutdown(() => {
    controller.stop();
    site.stop();
    if (standalone) standalone.stop();
  });
}

function onShutdown(fn) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      log.info(`${signal} received, shutting down`);
      fn();
      process.exit(0);
    });
  }
}
