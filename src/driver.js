"use strict";

const WebSocket = require("ws");

const log = require("./logger");

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

/**
 * The driver protocol this speaks.
 *
 * A map driver uses very little of it. It authenticates, says what role it is
 * and where its UI lives, and is then never asked anything: the console reads
 * project state over its own Socket.IO connection and forwards it into this
 * driver's page with postMessage. Holding the socket open is what makes the
 * map view available - the server reports a map driver as attached exactly
 * while this is connected.
 */
const PROTOCOL_VERSION = 2;
const DRIVER_ROLE = "map";
const DRIVER_NAME = "mapbox";

/**
 * What this driver's UI can do, declared once at the handshake.
 *
 * `nodeDrag` is the only one that means anything today: the console will not
 * accept a `sc:node-moved` from a page that did not say it moves checkpoints.
 */
const CAPABILITIES = { nodeDrag: true };

/** The server closes a socket with this when a newer driver takes its slot. */
const CLOSE_REPLACED = 4001;
/** ...and with this when it does not recognise the role in the auth message. */
const CLOSE_UNKNOWN_ROLE = 4003;

function describeError(err) {
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map((e) => (e && e.message) || String(e)).join("; ");
  }
  return (err && err.message) || String(err);
}

/**
 * The socket that makes this project's map view exist.
 *
 * Nothing routes here and nothing is answered. The one thing this driver tells
 * the server is where its page is, and even that is a proposal: an announced
 * address sits unapproved until an operator agrees to it, because the console
 * embeds it inside its own chrome and would otherwise be doing so on the
 * say-so of whoever holds an API key.
 */
class Driver {
  #config;
  #socket = null;
  #authenticated = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #stopped = false;
  #onFatal;

  constructor(config, { onFatal } = {}) {
    this.#config = config;
    this.#onFatal = onFatal || (() => {});
  }

  get connected() {
    return this.#authenticated;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#socket) {
      this.#socket.removeAllListeners();
      this.#socket.close();
      this.#socket = null;
    }
  }

  #connect() {
    log.info(`connecting to ${this.#config.wsUrl}`);

    const socket = new WebSocket(this.#config.wsUrl);
    this.#socket = socket;
    this.#authenticated = false;

    socket.on("open", () => {
      log.info("connected, authenticating");
      this.#send(
        {
          type: "auth",
          apiKey: this.#config.apiKey,
          protocolVersion: PROTOCOL_VERSION,
          role: DRIVER_ROLE,
          driverName: DRIVER_NAME,
          capabilities: CAPABILITIES,
          uiUrl: this.#config.uiUrl,
        },
        socket,
      );
    });

    socket.on("message", (raw) => this.#onMessage(raw, socket));

    socket.on("error", (err) => {
      log.error(`websocket error: ${describeError(err)}`);
    });

    socket.on("close", (code, reason) => {
      if (this.#socket !== socket) return;
      const detail = reason && reason.length ? ` (${reason.toString()})` : "";

      // Being replaced means another map driver holds this project's map slot,
      // and racing it would leave both flapping and neither serving a map. An
      // unrecognised role will still be unrecognised in a second.
      if (code === CLOSE_REPLACED || code === CLOSE_UNKNOWN_ROLE) {
        this.#socket = null;
        this.#authenticated = false;
        const reasonText =
          code === CLOSE_REPLACED
            ? "another driver took this project's map slot" +
              " - a second copy of this driver is already running"
            : "the server does not recognise this driver's role";
        log.error(`${reasonText}${detail}; not reconnecting`);
        this.stop();
        this.#onFatal(reasonText);
        return;
      }

      this.#scheduleReconnect(`connection closed with code ${code}${detail}`);
    });
  }

  #scheduleReconnect(reason) {
    this.#socket = null;
    this.#authenticated = false;
    if (this.#stopped || this.#reconnectTimer) return;

    this.#reconnectAttempt += 1;
    const backoff = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.#reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));

    log.warn(
      `${reason}; reconnecting in ${delay}ms (attempt ${this.#reconnectAttempt})`,
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #send(payload, socket) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  #onMessage(raw, socket) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      log.warn(
        `ignoring unparseable message from server: ${String(raw).slice(0, 200)}`,
      );
      return;
    }

    switch (message.type) {
      case "authenticated":
        this.#reconnectAttempt = 0;
        this.#authenticated = true;
        log.info(
          `authenticated for project ${message.projectId} on protocol ` +
            `v${Number(message.protocolVersion) || 1}; announced ${this.#config.uiUrl}`,
        );
        log.info(
          "the map view stays unavailable until an operator approves that " +
            "address in the console, under Project",
        );
        break;

      case "calculate-distance":
        // A map driver is never asked this. If it is, the server has put it in
        // the wrong slot, and answering would be worse than saying so.
        log.warn(
          "the server asked this map driver for a distance; ignoring - " +
            "distances come from a distance driver",
        );
        break;

      case "error":
        if (!this.#authenticated) {
          log.error(`authentication rejected by server: ${message.message}`);
          socket.close();
        } else {
          log.warn(`server reported an error: ${message.message}`);
        }
        break;

      default:
        break;
    }
  }
}

module.exports = { Driver, PROTOCOL_VERSION, CAPABILITIES };
