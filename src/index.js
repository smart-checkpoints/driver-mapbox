"use strict";

const log = require("./logger");
const { loadConfig } = require("./config");
const { Driver } = require("./driver");
const { createHttpServer } = require("./http");

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  console.error("See .env.example for the variables this driver reads.");
  process.exit(1);
}

log.setTag(`${config.driverName}/${config.driverVersion}`);
log.info(
  `starting: server=${config.wsUrl} ui=${config.uiUrl} style=${config.mapboxStyle}`,
);

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
void site.start().then(() => driver.start());

process.on("unhandledRejection", (reason) => {
  log.error(
    `unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`,
  );
});
process.on("uncaughtException", (err) => {
  log.error(`uncaught exception: ${err.stack || err.message}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    driver.stop();
    site.stop();
    process.exit(0);
  });
}
