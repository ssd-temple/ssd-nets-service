// Fix dotenv path for pkg executables running as Windows Services.
// process.cwd() is C:\Windows\System32 when run as a service,
// so we resolve .env relative to the exe's actual directory.
const __dotenvPath = require("path");
const __envFile = process.pkg
  ? __dotenvPath.join(__dotenvPath.dirname(process.execPath), '.env')
  : __dotenvPath.join(__dirname, '.env');

require("dotenv").config({ path: __envFile });

// nets-service-sdk resolves its own internal files — "log/platform-*.log"
// and "config.json" — relative to process.cwd(), with no fallback if that
// location isn't writable. Previously CWD was set to the exe's own install
// directory, which works for admin-run installs but throws an uncaught
// EPERM and crashes the whole service for a non-admin user whose install
// landed in a protected location (e.g. "C:\Program Files\..."). Point CWD
// at the same guaranteed-writable, already-tested location the app's own
// config already lives in (ProgramData, falling back to LocalAppData — see
// configPath.js) instead, so the SDK's relative paths always land
// somewhere this process can actually write, regardless of install
// location or the running user's privileges.
if (process.pkg) {
  process.chdir(require("./configPath").getConfigDir());
}

// Give node-canvas's Fontconfig/Pango stack a config it can always write to,
// BEFORE anything (amq/ESCPOSBuilder.js, amq/receiptImageGenerator.js) gets
// a chance to require('canvas'). Fixes Tamil text printing as tofu boxes on
// machines where the default profile-based Fontconfig cache path doesn't
// work (e.g. this service running as a Windows Service). See fontSetup.js.
require("./fontSetup").ensureFontconfigConfigured();

const express = require("express");
const moment = require("moment");
const _ = require("lodash");
const cors = require("cors");
const socket = require("socket.io");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const http = require("http");
const https = require("https");
const axios = require("axios");
const { execFile } = require("child_process");
const servicePackage = require("./package.json");
const DISPLAY_VERSION_PREFIX = 'SSD_EXE_';

function normaliseVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^(SSD_EXE|HEB_EXE|NKT)[_\-]?/i, '')
    .replace(/^v/i, '');
}

function isVersionNewer(candidateVersion, installedVersion) {
  const candidate = normaliseVersion(candidateVersion).split('.').map(part => Number.parseInt(part, 10) || 0);
  const installed = normaliseVersion(installedVersion).split('.').map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(candidate.length, installed.length);

  for (let index = 0; index < length; index += 1) {
    if ((candidate[index] || 0) !== (installed[index] || 0)) {
      return (candidate[index] || 0) > (installed[index] || 0);
    }
  }
  return false;
}

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

// Sync config.json BEFORE requiring SDK (SDK reads config.json at load time)
const configUtil = require("./configPath");
configUtil.ensureRuntimeDirs();
configUtil.syncSdkConfigFile();

const netsServiceSdk = require("nets-service-sdk");
const { verifyParser } = netsServiceSdk.responseHandler;
const fw = netsServiceSdk.manageConfig;
const { initialize, sentToTerminal, triggerRecovery } = netsServiceSdk.communication;
const { sendMessage } = netsServiceSdk;
const logger = netsServiceSdk.logger(module);
const localLogger = require("./logger");
localLogger.handleUncaught();
localLogger.teeConsole();
const { API_ENDPOINTS, MESSAGE_TYPES, SDK_EVENTS, WEBSOCKET_EVENTS } = require("./constants");
const amq = require("./amq");
const wsHandler = require("./websocket-handler").getInstance();
const nativeAddonSetup = require("./nativeAddonSetup");
const { getFontconfigDiagnostics } = require("./fontSetup");
const { getMachineId, validateLicense } = require("./license");
const internetMonitor = require("./src/internet-monitor");

const installLogPath = path.join(configUtil.getLogDir(), 'service-start.log');
function appendInstallLog(message) {
  try {
    fs.appendFileSync(installLogPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch (err) {
    // best effort logging
  }
}

appendInstallLog('Service startup beginning.');

// Single shared tracker for what the terminal actually said about each
// payment, and the one place every print path checks before printing a
// "paid" receipt. See amq/paymentOutcomes.js for why this had to move out
// of this file: it was previously only wired to one of several ways a
// payment could be started or a receipt printed.
const paymentTracker = require("./amq/paymentOutcomes");
const pendingPayment = require("./pendingPayment");
// SSD payment-confirmation + ticket-printing bridge — see each module's own
// header comment. Neither carries any payment/business logic of its own;
// both are pure bridge/print plumbing (SSD-Backend owns the confirmation
// dispatch and the deity/print-group resolution).
const ssdBackendClient = require("./amq/ssdBackendClient");
const ticketPrinter = require("./amq/ticketPrinter");

// Register device with the backend
async function registerDevice(deviceId, config) {
  const registrationHost = process.env.REGISTRATION_HOST;

  if (!registrationHost) {
    logger.warn({
      level: "warn",
      message: "REGISTRATION_HOST not set in environment variables. Skipping device registration.",
    });
    return null;
  }

  const registrationUrl = `${registrationHost}${API_ENDPOINTS.REGISTER_DEVICE}`;

  try {
    const payload = {
      device_id: deviceId,
      temple: config.temple || process.env.TEMPLE,
      node_id: config.node_id,
      terminal_status: config.terminal_status,
      timestamp: new Date().toISOString(),
    };

    logger.log({
      level: "info",
      message: `📡 Registering device with backend: ${registrationUrl}`,
    });
    logger.log({
      level: "info",
      message: `Attempting to register device: ${deviceId}`,
    });

    const response = await axios.post(registrationUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 10000, // 10 second timeout
      httpAgent,
      httpsAgent,
    });

    logger.log({
      level: "info",
      message: "✅ Device registration successful",
    });
    logger.log({
      level: "info",
      message: `Device registration successful: ${JSON.stringify(response.data)}`,
    });

    return response.data;
  } catch (error) {
    logger.error({
      level: "error",
      message: `❌ Device registration failed: ${error.message}`,
    });
    logger.error({
      level: "error",
      message: `Device registration failed: ${error.message}`,
    });
    return null;
  }
}

/**
 * The automatic NETS confirmation path — see the call site (the
 * global.io.emit interception, further below) for exactly when this fires:
 * only once paymentTracker has already verified a GENUINE terminal
 * approval, never on the terminal's raw/unverified "SUCCESS". Fire-and-
 * forget from that call site (it's inside a synchronous event-emit
 * override, which cannot itself be made async) — every failure here is
 * caught and logged, never thrown back out, so a backend-unreachable
 * failure can never crash the service or block the socket broadcast the
 * frontend is waiting on.
 *
 * Confirms the payment with SSD-Backend ONLY — it deliberately does NOT
 * print. Printing used to happen right here too, off the terminal's own
 * event, entirely independent of (and racing) the POS Portal frontend's own
 * ticket print — which is the single, correct trigger point (fires once a
 * booking is genuinely fully paid, with every payment mode actually
 * collected, e.g. "CASH, NETS"). Both prints going for the same ticket
 * meant whichever one reached the printer first — almost always this one,
 * since it needs no network round trip at all — won the ticketPrinter
 * dedupe race and silently starved out the frontend's own, more accurate
 * print request, always labelling the ticket "NETS" even when an earlier
 * Cash installment had also been collected. See PosPortalPage.tsx's
 * printTicketForBooking/finalizeBooking for that single trigger.
 *
 * @param {string} referenceId  the SSD-Backend order/reference id this
 *   payment was started against — paymentTracker.recordFinalOutcome()'s own
 *   `orderId`, which is always the SAME value passed to
 *   paymentTracker.beginPayment() when terminal:payment:nets was handled.
 * @param {object} sdkData  the (already outcome-verified) PAYMENT_MESSAGE payload
 */
async function confirmNetsPayment(referenceId, sdkData) {
  try {
    const translated = sdkData.response?.translated || {};
    const gatewayReference =
      translated.approvalCode && String(translated.approvalCode).trim() && !/^0+$/.test(String(translated.approvalCode))
        ? String(translated.approvalCode)
        : translated.retrievalReferenceNumber || `NETS-${Date.now()}`;

    await ssdBackendClient.confirmNetsPayment({
      referenceId,
      gatewayReference,
      amount: translated.amount != null && !Number.isNaN(Number(translated.amount)) ? Number(translated.amount) : undefined,
      terminalId: translated.terminalId,
      approvalCode: translated.approvalCode,
      // The terminal SDK's own translated response, sent through as-is so
      // SSD-Backend can store it verbatim on the PosTransaction row for
      // audit (card type, masked PAN, retrieval reference number, response
      // text, STAN, ...) — see that endpoint's own comment. Capped to a
      // plain-object subset (no nested objects/arrays) since the backend
      // only accepts up to 50 top-level keys and this is an audit trail,
      // not a field-by-field contract either side needs to keep in sync.
      terminalResponse: Object.fromEntries(
        Object.entries(translated).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
      ),
    });
  } catch (err) {
    logger.error({
      level: "error",
      message: `Automatic NETS confirmation failed for ${referenceId}: ${err.message}`,
    });
    // Without this, a failure here (backend unreachable, secret mismatch,
    // no pending payment found, ...) was invisible to whichever
    // browser tab actually started the payment — it had already seen the
    // terminal's own SUCCESS and was polling the booking's status,
    // waiting for a confirmation that was never going to arrive, with no
    // way to tell "still settling" apart from "never going to work" other
    // than eventually giving up. Broadcasting a genuine FAILED here (not
    // SUCCESS — the terminal already reported that) lets any listener stop
    // waiting immediately, with the real reason attached.
    sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
      status: "FAILED",
      action: "BACKEND_CONFIRMATION_FAILED",
      orderId: referenceId,
      message: `Terminal approved, but SSD-Backend could not confirm the booking: ${err.message}`,
    });
  }
}

// Initialize device ID
async function initializeDeviceId() {
  try {
    // Migrate legacy config.json → kiosk.netConfig (one-time)
    const migrated = configUtil.migrateFromLegacyConfig();
    if (migrated) {
      logger.log({
        level: "info",
        message: `📦 Migrated config.json → ${configUtil.CONFIG_FILENAME} at ${configUtil.getConfigPath()}`,
      });
    }

    // Sync .netConfig → config.json so the SDK can read it
    configUtil.syncSdkConfigFile();

    // Read config from .netConfig
    const config = configUtil.readConfig();

    logger.log({
      level: "info",
      message: `📂 Config loaded from: ${configUtil.getConfigPath()}`,
    });

    let isNewDevice = false;

    // Check if device_id already exists
    if (!config.device_id) {
      // Generate a unique device ID using UUID v4
      const deviceId = crypto.randomUUID();
      config.device_id = deviceId;
      isNewDevice = true;

      // Write back to .netConfig
      configUtil.writeConfig(config);
      // Sync to config.json for SDK compatibility
      configUtil.syncSdkConfigFile();

      logger.log({
        level: "info",
        message: "=".repeat(60) + "\n🆔 NEW DEVICE ID GENERATED\n" + "=".repeat(60) + `\nDevice ID: ${deviceId}\n` + "=".repeat(60),
      });

      logger.log({
        level: "info",
        message: `New Device ID generated: ${deviceId}`,
      });

      // Register the new device with the backend
      await registerDevice(deviceId, config);
    } else {
      logger.log({
        level: "info",
        message: "=".repeat(60) + "\n🆔 DEVICE ID\n" + "=".repeat(60) + `\nDevice ID: ${config.device_id}\n` + "=".repeat(60),
      });

      logger.log({
        level: "info",
        message: `Existing Device ID loaded: ${config.device_id}`,
      });
    }

    return config.device_id;
  } catch (error) {
    logger.error({
      level: "error",
      message: `Error initializing device ID: ${error}`,
    });
    logger.error({
      level: "error",
      message: `Failed to initialize device ID: ${error.message}`,
    });
    return null;
  }
}

// Initialize device ID and AMQ on startup (using IIFE to handle async)
let deviceId;
let amqConnection;
let amqSubscriber;
let amqPublisher;

(async () => {
  try {
    // Initialize device ID
    deviceId = await initializeDeviceId();

    // Set WebSocket handler for AMQ connection
    amq.connection.setWebSocketHandler(wsHandler);

    // Initialize AMQ connection
    amqConnection = amq.connection.getInstance();
    const channel = await amqConnection.connect();

    // Skip AMQ subscriber and publisher initialization if connection was skipped
    if (!channel) {
      logger.warn({
        level: "warn",
        message: "⏭️  AMQ subscriber and publisher initialization skipped",
      });
      logger.warn({
        level: "warn",
        message: "AMQ subscriber and publisher initialization skipped due to missing environment variables",
      });
      return;
    }

    // Initialize subscriber
    amqSubscriber = amq.subscriber.getInstance();

    // Register message handlers for terminal operations
    amqSubscriber.registerHandler(MESSAGE_TYPES.TERMINAL_STATUS, async (message) => {
      logger.log({
        level: "info",
        message: `📊 Processing TERMINAL_STATUS: ${JSON.stringify(message)}`,
      });

      // See ensureTerminalConnected() above — this handler used to call
      // sentToTerminal() with no connectivity check at all.
      const portStatus = await ensureTerminalConnected();
      if (!portStatus.success) {
        sendMessage('clientRoom', SDK_EVENTS.STATUS_MESSAGE, terminalNotConnectedPayload("status_check", "FAILED_TO_GET_THE_STATUS", portStatus.error));
        return;
      }

      sentToTerminal("STATUS_CHECK");

      // Emit WebSocket event
      sendMessage('clientRoom', 'AMQ_TERMINAL_STATUS', {
        type: MESSAGE_TYPES.TERMINAL_STATUS,
        data: message,
      });
    });

    amqSubscriber.registerHandler(MESSAGE_TYPES.TERMINAL_LOGON, async (message) => {
      logger.log({
        level: "info",
        message: `🔐 Processing TERMINAL_LOGON: ${JSON.stringify(message)}`,
      });

      const portStatus = await ensureTerminalConnected();
      if (!portStatus.success) {
        sendMessage('clientRoom', SDK_EVENTS.LOGON_MESSAGE, terminalNotConnectedPayload("logon", "FAILED_TO_LOGON", portStatus.error));
        return;
      }

      sentToTerminal("LOGON");

      // Emit WebSocket event
      sendMessage('clientRoom', 'AMQ_TERMINAL_LOGON', {
        type: MESSAGE_TYPES.TERMINAL_LOGON,
        data: message,
      });
    });

    amqSubscriber.registerHandler(MESSAGE_TYPES.TERMINAL_PAYMENT, async (message) => {
      logger.log({
        level: "info",
        message: `💳 Processing TERMINAL_PAYMENT: ${JSON.stringify(message)}`,
      });

      const orderId = message.orderId || message.data?.orderId;

      const portStatus = await ensureTerminalConnected();
      if (!portStatus.success) {
        sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
          status: "FAILED",
          action: "TERMINAL_ERROR",
          error: portStatus.error,
          message: "Terminal is not connected.",
          orderId,
        });
        return;
      }

      // Cloud-triggered payments used to skip this bookkeeping entirely,
      // so a payment started this way had no recorded outcome for
      // handleTerminalReceipt to check later, however it was eventually
      // printed. Track it the same way the Socket.IO path does.
      try {
        if (orderId) paymentTracker.beginPayment(orderId);
      } catch (error) {
        logger.error({
          level: "error",
          message: `🚫 Refusing AMQ-triggered payment for order ${orderId}: ${error.message}`,
        });
        return; // don't forward to the terminal — message is still ack'd by the subscriber
      }

      // Same durable crash-recovery marker as the Socket.IO and HTTP
      // payment paths (see pendingPayment.js) — an AMQ-triggered payment
      // reaches the terminal exactly the same way and needs the same
      // protection against the service restarting mid-transaction.
      pendingPayment.beginTracking(
        orderId,
        message.data?.cloud_url || fw.getConfigByKey("cloud_url"),
      );

      sentToTerminal(message.isCreditTxn ? "CREDIT_PAYMENT" : "PAYMENT", message.data);

      // Emit WebSocket event
      sendMessage('clientRoom', 'AMQ_TERMINAL_PAYMENT', {
        type: MESSAGE_TYPES.TERMINAL_PAYMENT,
        data: message,
      });
    });

    amqSubscriber.registerHandler(MESSAGE_TYPES.TERMINAL_RESPONSE, (message) => {
      logger.log({
        level: "info",
        message: `📨 Processing TERMINAL_RESPONSE: ${JSON.stringify(message)}`,
      });
      // TODO: Add terminal response handling logic here

      // Emit WebSocket event
      sendMessage('clientRoom', 'AMQ_TERMINAL_RESPONSE', {
        type: MESSAGE_TYPES.TERMINAL_RESPONSE,
        data: message,
      });
    });

    amqSubscriber.registerHandler(MESSAGE_TYPES.SERVICE_STATUS, (message) => {
      logger.log({
        level: "info",
        message: `🔧 Processing SERVICE_STATUS: ${JSON.stringify(message)}`,
      });
      // TODO: Add service status logic here

      // Emit WebSocket event
      sendMessage('clientRoom', 'AMQ_SERVICE_STATUS', {
        type: MESSAGE_TYPES.SERVICE_STATUS,
        data: message,
      });
    });

    // Start subscribing to messages
    await amqSubscriber.subscribe();

    // Initialize publisher
    amqPublisher = amq.publisher.getInstance();

    logger.log({
      level: "info",
      message: "\n" + "=".repeat(60) + "\n✅ AMQ Integration Complete\n" + "=".repeat(60) + "\n",
    });
  } catch (error) {
    logger.error({
      level: "error",
      message: `❌ Failed to initialize AMQ: ${error.message}`,
    });
    logger.error({
      level: "error",
      message: `Failed to initialize AMQ: ${error.message}`,
    });
  }
})();

const config = fw.getConfig();

const app = express();

app.use(localLogger.requestLogger);
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

localLogger.info('Express server started');



/*
Check the Terminal Status
*/
app.post("/terminal/status", async (req, res) => {
  try {
    // sentToTerminal() is async and DOES check port connectivity
    // internally, but this route never awaited it and always responded
    // { success: true } regardless of the result — the only thing that
    // failing to await could throw synchronously was a JS error, not a
    // disconnected terminal. That's why "Check Status" reported success
    // even with the terminal physically unplugged. Check connectivity
    // ourselves first (giving a just-triggered SDK re-init a moment to
    // finish — see ensureTerminalConnected) and base both the HTTP
    // response and the broadcast STATUS_MESSAGE (which the kiosk/POS
    // "Connected" badge relies on) on the real result.
    const portStatus = await ensureTerminalConnected();

    if (!portStatus.success) {
      // Built once and reused for both: the broadcast previously carried a
      // diagnostic "message" (e.g. naming a leftover legacy service holding
      // the port) that this HTTP response discarded, sending only the bare
      // "PORT_NOT_OPEN"/"PORT_DISCONNECTED" code back to whoever clicked
      // "Check Status" — so the one detail that actually explains WHY never
      // reached the person looking at the screen, only the log file.
      const failurePayload = terminalNotConnectedPayload("status_check", "FAILED_TO_GET_THE_STATUS", portStatus.error);
      sendMessage('clientRoom', SDK_EVENTS.STATUS_MESSAGE, failurePayload);
      return res.send({ success: false, error: failurePayload.error, message: failurePayload.message });
    }

    sentToTerminal("STATUS_CHECK");

    // Emit WebSocket event
    wsHandler.emitTerminalStatus({
      action: "STATUS_CHECK",
      timestamp: new Date().toISOString(),
    });

    return res.send({ success: true });
  } catch (e) {
    return res.send({ success: false, error: e.message });
  }
});

app.get("/status", async (req, res) => {
  try {
    const status = fw.getConfigByKey("terminal_status");
    return res.send({ success: status });
  } catch (e) {
    return res.send(e);
  }
});

/*
Get Device ID
*/
app.get("/device/id", async (req, res) => {
  try {
    const deviceId = fw.getConfigByKey("device_id");
    return res.send({ success: true, device_id: deviceId });
  } catch (e) {
    return res.send({ success: false, error: e.message });
  }
});


/*
Trigger Logon
*/
app.post("/terminal/logon", async (req, res) => {
  try {
    // See /terminal/status above for why this check is needed — without
    // it, this always responded { success: true } even with the terminal
    // physically unplugged.
    const portStatus = await ensureTerminalConnected();

    if (!portStatus.success) {
      // See /terminal/status above — reuse the built payload's "message"
      // instead of dropping it and sending only the bare error code.
      const failurePayload = terminalNotConnectedPayload("logon", "FAILED_TO_LOGON", portStatus.error);
      sendMessage('clientRoom', SDK_EVENTS.LOGON_MESSAGE, failurePayload);
      return res.send({ success: false, error: failurePayload.error, message: failurePayload.message });
    }

    sentToTerminal("LOGON");

    // Emit WebSocket event
    wsHandler.emitTerminalLogon({
      action: "LOGON",
      timestamp: new Date().toISOString(),
    });

    return res.send({ success: true });
  } catch (e) {
    return res.send({ success: false, error: e.message });
  }
});

app.post("/terminal/parser", (req, res) => {
  const { body } = req;
  try {
    const value = body.hexValue.substring(4, body.hexValue.length - 2);
    const lrcCheck = body.hexValue.substring(body.hexValue.length - 2, body.hexValue.length)
    const response = verifyParser(body.hexValue, body.ecn, body.type);
    return res.send(response);
  } catch (e) {
    return res.send(e);
  }
});

/*
Trigger Payment
*/
app.post("/terminal/payment", async (req, res) => {
  const { body } = req;
  try {
    // See /terminal/status above — this route used to call sentToTerminal()
    // with no connectivity check at all, inheriting the SDK's fallthrough
    // (write-to-a-closed-port) bug on a disconnected terminal.
    const portStatus = await ensureTerminalConnected();
    if (!portStatus.success) {
      sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
        status: "FAILED",
        action: "TERMINAL_ERROR",
        error: portStatus.error,
        message: "Terminal is not connected.",
        orderId: body.orderId,
      });
      return res.send({ success: false, error: portStatus.error || "Terminal is not connected." });
    }

    // This HTTP route used to skip the payment-outcome bookkeeping that
    // the Socket.IO command path does, so a payment started here had no
    // recorded result for the receipt-printing safety check to find later.
    if (body.orderId) {
      paymentTracker.beginPayment(body.orderId);
    }

    // Same durable crash-recovery marker as the Socket.IO payment path
    // (see pendingPayment.js) — this route reaches the terminal too, so a
    // payment started here needs the same protection against the service
    // restarting mid-transaction.
    pendingPayment.beginTracking(
      body.orderId,
      body.cloud_url || fw.getConfigByKey("cloud_url"),
    );

    sentToTerminal(body.isCreditTxn ? "CREDIT_PAYMENT" : "PAYMENT", body);

    // Emit WebSocket event
    wsHandler.emitTerminalPayment({
      ...body,
      action: body.isCreditTxn ? "CREDIT_PAYMENT" : "PAYMENT",
      timestamp: new Date().toISOString(),
    });

    return res.send({ success: true });
  } catch (e) {
    return res.send({ success: false, error: e.message });
  }
});

/*
AMQ Publish Message Endpoint (for testing)
*/
app.post("/amq/publish", async (req, res) => {
  try {
    const { message, type } = req.body;

    if (!message) {
      return res.status(400).send({ success: false, error: "Message is required" });
    }

    if (!amqPublisher) {
      return res.status(503).send({ success: false, error: "AMQ not initialized" });
    }

    await amqPublisher.publish(message, type || MESSAGE_TYPES.SERVICE_STATUS);
    return res.send({ success: true, message: "Message published successfully" });
  } catch (error) {
    logger.error({
      level: "error",
      message: `Failed to publish message: ${error.message}`,
    });
    return res.status(500).send({ success: false, error: error.message });
  }
});

/*
AMQ Status Endpoint
*/
app.get("/amq/status", async (req, res) => {
  try {
    const isConnected = amqConnection ? amqConnection.isConnectionActive() : false;
    return res.send({
      success: true,
      connected: isConnected,
      queue: process.env.AMQ_QUEUE,
    });
  } catch (error) {
    return res.status(500).send({ success: false, error: error.message });
  }
});

/*
Socket Simulation API - For Testing SDK Events
*/

// Simulate STATUS_MESSAGE event
app.post("/api/simulate/status", async (req, res) => {
  try {
    const { status = "SUCCESS", action } = req.body;

    let eventData;

    switch (status) {
      case "INITIATED":
        eventData = {
          status: "INITIATED",
          action: action || "STATUS_CHECK_INITIATED",
        };
        break;
      case "SUCCESS":
        eventData = {
          status: "SUCCESS",
          request: "status_check",
          action: action || "COMPLETED",
        };
        break;
      case "FAILED":
        eventData = {
          status: "FAILED",
          request: "status_check",
          action: action || "FAILED_TO_GET_THE_STATUS",
        };
        break;
      default:
        return res.status(400).send({
          success: false,
          error: "Invalid status. Use: INITIATED, SUCCESS, or FAILED"
        });
    }

    // Use SDK's sendMessage to emit the event
    sendMessage('clientRoom', SDK_EVENTS.STATUS_MESSAGE, eventData);

    logger.log({
      level: "info",
      message: `📊 Simulated STATUS_MESSAGE: ${JSON.stringify(eventData)}`,
    });

    return res.send({
      success: true,
      message: "Status event simulated",
      data: eventData
    });
  } catch (error) {
    logger.error({
      level: "error",
      message: `Failed to simulate status: ${error.message}`,
    });
    return res.status(500).send({ success: false, error: error.message });
  }
});

// Simulate LOGON_MESSAGE event
app.post("/api/simulate/logon", async (req, res) => {
  try {
    const { status = "SUCCESS", action } = req.body;

    let eventData;

    switch (status) {
      case "INITIATED":
        eventData = {
          status: "INITIATED",
          action: action || "LOGON_INITIATED",
        };
        break;
      case "SUCCESS":
        eventData = {
          status: "SUCCESS",
          request: "logon",
          action: action || "COMPLETED",
        };
        break;
      case "FAILED":
        eventData = {
          status: "FAILED",
          request: "logon",
          action: action || "FAILED_TO_LOGON",
        };
        break;
      default:
        return res.status(400).send({
          success: false,
          error: "Invalid status. Use: INITIATED, SUCCESS, or FAILED"
        });
    }

    // Use SDK's sendMessage to emit the event
    sendMessage('clientRoom', SDK_EVENTS.LOGON_MESSAGE, eventData);

    logger.log({
      level: "info",
      message: `🔐 Simulated LOGON_MESSAGE: ${JSON.stringify(eventData)}`,
    });

    return res.send({
      success: true,
      message: "Logon event simulated",
      data: eventData
    });
  } catch (error) {
    logger.error({
      level: "error",
      message: `Failed to simulate logon: ${error.message}`,
    });
    return res.status(500).send({ success: false, error: error.message });
  }
});

// Simulate PAYMENT_MESSAGE event
app.post("/api/simulate/payment", async (req, res) => {
  try {
    const {
      status = "SUCCESS",
      action,
      amount = "10.00",
      reference = "TEST123",
      cardType = "VISA",
      responseStatus = "APPROVED"
    } = req.body;

    let eventData;

    switch (status) {
      case "INITIATED":
        eventData = {
          status: "INITIATED",
          action: action || "PAYMENT_INITIATED",
        };
        break;
      case "SUCCESS":
        eventData = {
          status: "SUCCESS",
          response: {
            translated: {
              status: responseStatus,
              amount: amount,
              reference: reference,
              cardType: cardType,
              approvalCode: "123456",
              transactionId: `TXN${Date.now()}`,
            },
            raw: "0200..." // Simulated raw data
          },
          action: action || "COMPLETED",
        };
        break;
      case "RETRY":
        eventData = {
          status: "RETRY",
          response: {
            translated: {
              status: "TIME_OUT",
              amount: amount,
              reference: reference,
            }
          },
          action: action || "RETRY",
        };
        break;
      case "CANCELLED":
        eventData = {
          status: "CANCELLED",
          response: {
            translated: {
              status: responseStatus || "USER_CANCELLED",
              amount: amount,
              reference: reference,
            }
          },
          action: action || "CANCELLED",
        };
        break;
      case "TERMINAL_ERROR":
        eventData = {
          status: "TERMINAL_ERROR",
          action: action || "TERMINAL_ERROR",
        };
        break;
      case "APPROVED_FLAGGED":
        eventData = {
          status: "APPROVED_FLAGGED",
          response: {
            translated: {
              status: "APPROVED",
              amount: amount,
              reference: reference,
              flagReason: "High value transaction",
            }
          },
          action: action || "APPROVED_FLAGGED",
        };
        break;
      default:
        return res.status(400).send({
          success: false,
          error: "Invalid status. Use: INITIATED, SUCCESS, RETRY, CANCELLED, TERMINAL_ERROR, or APPROVED_FLAGGED"
        });
    }

    // Use SDK's sendMessage to emit the event
    sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, eventData);

    logger.log({
      level: "info",
      message: `💳 Simulated PAYMENT_MESSAGE: ${JSON.stringify(eventData)}`,
    });

    return res.send({
      success: true,
      message: "Payment event simulated",
      data: eventData
    });
  } catch (error) {
    logger.error({
      level: "error",
      message: `Failed to simulate payment: ${error.message}`,
    });
    return res.status(500).send({ success: false, error: error.message });
  }
});

// Simulate complete payment flow
app.post("/api/simulate/payment-flow", async (req, res) => {
  try {
    const {
      amount = "10.00",
      reference = "TEST123",
      outcome = "SUCCESS" // SUCCESS, CANCELLED, RETRY, TERMINAL_ERROR
    } = req.body;

    // `reference` here IS the orderId a real terminal:payment:nets caller
    // would have passed — beginPayment() must be called before this
    // simulated PAYMENT_MESSAGE fires, or paymentOutcomes.js has no
    // pendingOrderId to attribute it to and the whole SSD confirmation
    // pipeline (see the global.io.emit interception below, and
    // confirmNetsPayment) silently no-ops, exactly as if this route had
    // never been called. This is what makes this endpoint a genuine
    // end-to-end test rather than only a socket-broadcast smoke test — see
    // NETS-Service's own testing docs.
    try {
      paymentTracker.beginPayment(reference);
    } catch (err) {
      return res.status(409).send({ success: false, error: err.message });
    }

    // Step 1: Payment Initiated
    sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
      status: "INITIATED",
      action: "PAYMENT_INITIATED",
    });

    logger.log({
      level: "info",
      message: "💳 Payment flow started: INITIATED",
    });

    // Step 2: Wait 2 seconds, then send outcome
    setTimeout(() => {
      let finalEvent;

      switch (outcome) {
        case "SUCCESS":
          finalEvent = {
            status: "SUCCESS",
            response: {
              translated: {
                status: "APPROVED",
                amount: amount,
                reference: reference,
                cardType: "VISA",
                approvalCode: "123456",
                transactionId: `TXN${Date.now()}`,
              }
            },
            action: "COMPLETED",
          };
          break;
        case "CANCELLED":
          finalEvent = {
            status: "CANCELLED",
            response: {
              translated: {
                status: "USER_CANCELLED",
                amount: amount,
                reference: reference,
              }
            },
            action: "CANCELLED",
          };
          break;
        case "RETRY":
          finalEvent = {
            status: "RETRY",
            response: {
              translated: {
                status: "TIME_OUT",
                amount: amount,
                reference: reference,
              }
            },
            action: "RETRY",
          };
          break;
        case "TERMINAL_ERROR":
          finalEvent = {
            status: "TERMINAL_ERROR",
            action: "TERMINAL_ERROR",
          };
          break;
        default:
          finalEvent = {
            status: "SUCCESS",
            response: {
              translated: {
                status: "APPROVED",
                amount: amount,
                reference: reference,
              }
            },
            action: "COMPLETED",
          };
      }

      sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, finalEvent);

      logger.log({
        level: "info",
        message: `💳 Payment flow completed: ${outcome}`,
      });
    }, 2000);

    return res.send({
      success: true,
      message: "Payment flow simulation started (will complete in 2 seconds)",
      outcome: outcome
    });
  } catch (error) {
    logger.error({
      level: "error",
      message: `Failed to simulate payment flow: ${error.message}`,
    });
    return res.status(500).send({ success: false, error: error.message });
  }
});


/*
 Print API Endpoints
*/
const printService = require("./amq/printService");
printService.setWebSocketHandler(wsHandler);
const ESCPOSBuilder = require("./amq/ESCPOSBuilder");

// Pay the one-time canvas/Fontconfig/Pango init cost now, at service
// startup, instead of on the first customer's ticket (see ESCPOSBuilder.js).
ESCPOSBuilder.warmUp();

// Collects everything needed to diagnose "why doesn't Tamil/printing work
// on this machine" without needing hands-on access: what got self-extracted
// where, whether canvas actually loaded, and basic OS/account context (the
// most common real-world causes are the account this runs as not being able
// to write anywhere we tried, or antivirus quarantining a freshly-extracted
// DLL — both show up clearly here).
function getNativeDiagnostics() {
  const os = require("os");
  return {
    canvas: ESCPOSBuilder.getCanvasStatus(),
    fontconfig: getFontconfigDiagnostics(),
    paths: nativeAddonSetup.getDiagnostics(),
    runningAs: process.env.USERNAME || process.env.USER || "unknown",
    isWindowsService: process.env.USERNAME === undefined, // nssm/SCM strips most user env vars
    platform: `${process.platform} ${os.release()}`,
    nodeVersion: process.version,
  };
}

// GET /api/diagnostics/native — check canvas/font/DLL health on this
// specific machine, e.g. from a browser at http://localhost:5200 or via
// curl, without needing to grep log files.
app.get("/api/diagnostics/native", (req, res) => {
  res.send({ success: true, diagnostics: getNativeDiagnostics() });
});

// Get list of printers
app.get("/api/printers", async (req, res) => {
  try {
    const printers = await printService.getPrinters();
    return res.send({ success: true, printers });
  } catch (e) {
    logger.error({
      level: "error",
      message: `Failed to get printers: ${e.message}`,
    });
    return res.status(500).send({ success: false, error: e.message });
  }
});

// List available COM/serial ports
app.get("/api/ports", async (req, res) => {
  try {
    const { SerialPort } = require("serialport");
    const ports = await SerialPort.list();
    return res.send({
      success: true,
      ports: ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || '',
        pnpId: p.pnpId || ''
      }))
    });
  } catch (e) {
    logger.error({
      level: "error",
      message: `Failed to list ports: ${e.message}`,
    });
    return res.status(500).send({ success: false, error: e.message });
  }
});

// Get current configuration
app.get("/api/config", async (req, res) => {
  try {
    const config = configUtil.readConfig();
    const version = servicePackage.version;
    return res.send({
      success: true,
      config: {
        printerName: config.printerName,
        printerPort: config.printerPort,
        // Also the backend domain that receives the automatic NETS payment
        // confirmation callback (see amq/ssdBackendClient.js) — one URL
        // field instead of a separate, easy-to-forget "SSD Backend URL".
        cloud_url: config.cloud_url,
        com: config.com,
        simulation: config.simulation,
        updateRepo: config.updateRepo || '',
        githubToken: config.githubToken || '',
        version,
        displayVersion: `${DISPLAY_VERSION_PREFIX}${version}`,
        lastUpdateCheckAt: config.lastUpdateCheckAt || null,
        lastUpdateInstalledAt: config.lastUpdateInstalledAt || null,
      }
    });
  } catch (e) {
    logger.error({
      level: "error",
      message: `Failed to get config: ${e.message}`,
    });
    return res.status(500).send({ success: false, error: e.message });
  }
});

app.get("/api/version", async (req, res) => {
  try {
    const version = servicePackage.version;
    return res.send({
      success: true,
      version,
      displayVersion: `${DISPLAY_VERSION_PREFIX}${version}`,
    });
  } catch (e) {
    logger.error({
      level: "error",
      message: `Failed to get version: ${e.message}`,
    });
    return res.status(500).send({ success: false, error: e.message });
  }
});

// The update repo is a private GitHub repo, so anonymous requests to the
// releases API 404 the same way a nonexistent repo would. A token is
// required to see releases at all, and the same token is needed again to
// download a release asset (a private repo's browser_download_url requires
// an authenticated browser session, not just knowing the URL).
function getGithubAuthHeaders(config) {
  const token = (config.githubToken || process.env.UPDATE_REPO_TOKEN || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function parseGithubRepo(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/|$)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

const DEFAULT_DOWNLOAD_FILENAME = 'NETS-and-Printer-Service-update.exe';

function safeDownloadFilename(rawName) {
  const stripped = path.basename(String(rawName || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return /\.(exe|msi)$/i.test(stripped) ? stripped : DEFAULT_DOWNLOAD_FILENAME;
}

app.get('/api/update/check', async (req, res) => {
  try {
    const config = configUtil.readConfig();
    const repoUrl = config.updateRepo || process.env.UPDATE_REPO_URL;

    if (!repoUrl) {
      return res.status(400).send({ success: false, error: 'Update repository URL is not configured.' });
    }

    const parsed = parseGithubRepo(repoUrl);
    if (!parsed) {
      return res.status(400).send({ success: false, error: 'Unsupported update repository. Please use a GitHub repo URL.' });
    }

    const { owner, repo } = parsed;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const authHeaders = getGithubAuthHeaders(config);

    const githubResponse = await axios.get(apiUrl, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NETS-KioskService',
        ...authHeaders,
      },
      timeout: 15000,
    });

    const release = githubResponse.data;
    const releaseVersion = release.tag_name || release.name;
    const installerAsset = (release.assets || []).find(asset => /\.(exe|msi)$/i.test(asset.name));
    // Point the installer at our own /api/update/download proxy rather than
    // GitHub's browser_download_url directly — for a private repo that URL
    // needs an authenticated GitHub session, which Electron's plain
    // session.downloadURL() can't provide. The proxy re-fetches the asset
    // from GitHub server-side using the same token, so the token itself
    // never has to reach the renderer/download session.
    const origin = `${req.protocol}://${req.get('host')}`;
    const lastUpdateCheckAt = new Date().toISOString();
    // Recorded on every check — manual (button click) or automatic (the
    // hourly check in electron/main.js) — since both hit this same endpoint.
    try {
      configUtil.updateConfig({ lastUpdateCheckAt });
    } catch (err) {
      logger.error({ level: 'error', message: `Failed to record update-check timestamp: ${err.message}` });
    }
    return res.send({
      success: true,
      version: releaseVersion,
      displayVersion: `${DISPLAY_VERSION_PREFIX}${normaliseVersion(releaseVersion)}`,
      updateAvailable: isVersionNewer(releaseVersion, servicePackage.version),
      installer: installerAsset ? {
        name: installerAsset.name,
        downloadUrl: `${origin}/api/update/download/${installerAsset.id}?filename=${encodeURIComponent(installerAsset.name)}`,
      } : null,
      url: release.html_url,
      notes: release.body || '',
      lastUpdateCheckAt,
    });
  } catch (e) {
    const status = e.response?.status;
    let message = e.message;
    if (status === 404) {
      message = 'No release found, or the configured GitHub token cannot see this private repository\'s releases. Check the repo URL and that a valid token with "Contents: Read" access is configured.';
    } else if (status === 401 || status === 403) {
      message = 'GitHub rejected the configured token. Check the "GitHub Token" field in Service Configuration.';
    }
    logger.error({ level: 'error', message: `Failed to check for updates: ${message}` });
    return res.status(500).send({ success: false, error: message });
  }
});

// Proxies a release asset download through this service using the
// configured GitHub token, so private-repo installer assets can be fetched
// without ever exposing the token to the Electron renderer.
app.get('/api/update/download/:assetId', async (req, res) => {
  try {
    const assetId = Number.parseInt(req.params.assetId, 10);
    if (!Number.isInteger(assetId) || assetId <= 0) {
      return res.status(400).send({ success: false, error: 'Invalid asset id.' });
    }

    const config = configUtil.readConfig();
    const repoUrl = config.updateRepo || process.env.UPDATE_REPO_URL;
    if (!repoUrl) {
      return res.status(400).send({ success: false, error: 'Update repository URL is not configured.' });
    }

    const parsed = parseGithubRepo(repoUrl);
    if (!parsed) {
      return res.status(400).send({ success: false, error: 'Unsupported update repository.' });
    }

    const { owner, repo } = parsed;
    const assetUrl = `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`;
    const authHeaders = getGithubAuthHeaders(config);

    const assetResponse = await axios.get(assetUrl, {
      headers: {
        'Accept': 'application/octet-stream',
        'User-Agent': 'NETS-KioskService',
        ...authHeaders,
      },
      responseType: 'stream',
      timeout: 60000,
    });

    // Content-Disposition matters here beyond cosmetics: without it,
    // Electron's download manager has nothing but the numeric asset-id URL
    // segment to name the file from, and can end up guessing a filename/
    // extension that doesn't match the actual content at all.
    const suggestedName = safeDownloadFilename(req.query.filename);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${suggestedName}"`);
    if (assetResponse.headers['content-length']) {
      res.setHeader('Content-Length', assetResponse.headers['content-length']);
    }
    assetResponse.data.pipe(res);
  } catch (e) {
    logger.error({ level: 'error', message: `Failed to download update asset: ${e.message}` });
    return res.status(502).send({ success: false, error: `Failed to download update asset: ${e.message}` });
  }
});

// Update printer configuration
app.post("/api/config/printer", async (req, res) => {
  try {
    const { printerName, printerPort } = req.body;

    if (!printerName || !printerPort) {
      return res.status(400).send({
        success: false,
        error: "Both printerName and printerPort are required"
      });
    }

    // Update config using the correct method
    configUtil.updateConfig({
      printerName,
      printerPort
    });
    configUtil.syncSdkConfigFile();

    logger.log({
      level: "info",
      message: `Printer configuration updated: ${printerName} (${printerPort})`,
    });

    // Any ticket confirmed while no printer was set up (see
    // ticketPrinter.js's pending-print queue) can now actually print —
    // fire-and-forget so this response doesn't wait on it, errors are
    // logged inside drainPendingPrints() itself and failed entries just
    // stay queued for the next attempt.
    ticketPrinter.drainPendingPrints(printerName).catch((err) => {
      logger.error({ level: "error", message: `Pending-print queue drain failed: ${err.message}` });
    });

    return res.send({
      success: true,
      message: "Printer configuration updated successfully",
      config: {
        printerName,
        printerPort
      }
    });
  } catch (e) {
    logger.error({
      level: "error",
      message: `Failed to update printer config: ${e.message}`,
    });
    return res.status(500).send({ success: false, error: e.message });
  }
});

// Update service configuration
// nets-service-sdk reads config.json exactly once, at require() time
// (communication.js: `var config = fw.getConfig();`), and every terminal
// call (status check, logon, payment) reads the port from that one cached
// snapshot — never from disk again. So saving a new COM/simulation port
// through this endpoint updates kiosk.netConfig and the SDK's config.json
// on disk correctly, but the SDK's already-running in-memory copy is stale
// until the process restarts, and status/logon keep failing with an empty
// port ("Port  is NOT connected") no matter how many times the same value
// is re-saved. There's no public API on the SDK to reload that cache, so
// the fix is to restart this process when a field that actually affects
// the terminal connection changes — Electron auto-relaunches it (see
// electron/main.js) with the now-correct config.json already in place.
const TERMINAL_AFFECTING_FIELDS = ["com", "simulation"];

app.post("/api/config/service", async (req, res) => {
  try {
    const {
      cloud_url,
      com,
      simulation,
      updateRepo,
      githubToken,
    } = req.body;

    const updates = {};
    // Also the backend domain amq/ssdBackendClient.js posts the automatic
    // NETS payment confirmation callback to — see that file for why a
    // separate "SSD Backend URL" field was removed in favor of reusing this
    // one (a temple only ever has one backend, and a second field just
    // meant two places to keep in sync).
    if (cloud_url !== undefined) updates.cloud_url = cloud_url;
    if (com !== undefined) updates.com = com;
    if (simulation !== undefined) updates.simulation = Boolean(simulation);
    if (updateRepo !== undefined) updates.updateRepo = updateRepo;
    if (githubToken !== undefined) updates.githubToken = githubToken;

    if (Object.keys(updates).length === 0) {
      return res.status(400).send({
        success: false,
        error: "No valid configuration fields provided"
      });
    }

    const previousConfig = configUtil.readConfig();
    const terminalSettingsChanged = TERMINAL_AFFECTING_FIELDS.some(
      (key) => key in updates && updates[key] !== previousConfig[key]
    );

    configUtil.updateConfig(updates);
    configUtil.syncSdkConfigFile();

    logger.log({
      level: "info",
      message: `Service configuration updated: ${JSON.stringify(updates)}`,
    });

    res.send({
      success: true,
      message: terminalSettingsChanged
        ? "Service configuration updated successfully. Restarting the service to apply the terminal port change..."
        : "Service configuration updated successfully",
      config: updates,
      restarting: terminalSettingsChanged,
    });

    if (terminalSettingsChanged) {
      logger.log({
        level: "info",
        message: "🔄 Terminal-affecting config changed — restarting service so the SDK picks up the new port.",
      });
      // Give the response above time to actually reach the client before
      // this process exits. The payload is a few hundred bytes over
      // loopback — Node writes it to the OS socket buffer synchronously
      // inside res.send(), so this only needs to cover scheduling jitter,
      // not real transfer time. Was 400ms; 150ms already has comfortable
      // margin and shaves noticeable time off every save-triggered restart.
      setTimeout(() => process.exit(0), 150);
    }
  } catch (e) {
    logger.error({
      level: "error",
      message: `Failed to update service config: ${e.message}`,
    });
    return res.status(500).send({ success: false, error: e.message });
  }
});

// electron/main.js hits this when it finds an already-running service whose
// reported /api/version doesn't match the just-installed build — normally
// impossible (before-quit already kills the child it spawned), but reachable
// after an abnormal exit (Electron force-killed from Task Manager, a crash)
// leaves the old kioskservice.exe orphaned and still holding its port. Without
// this, the previous fix for that case just dodged the stray process by
// picking a new port each time, leaving it running forever — burning
// resources and, worse, potentially still holding the terminal's COM port
// open so the newly-started (correct-version) service can never open it.
// Restricted to loopback: this service binds all interfaces (see
// app.listen below), and unlike every other route here this one's sole
// purpose is to kill the process, so it doesn't get the same LAN exposure
// as the rest of the API.
function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

app.post("/api/internal/shutdown", (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).send({ success: false, error: "This endpoint is only available from localhost." });
  }

  logger.log({
    level: "info",
    message: "🛑 Shutdown requested by desktop shell (stale/legacy instance being replaced).",
  });

  res.send({ success: true });
  setTimeout(() => process.exit(0), 200);
});


// Print JSON via receiptline
app.post("/api/print-json", async (req, res) => {
  try {
    const { body } = req;
    // Use printer from request or fallback to config
    const printerName = body.printerName || fw.getConfigByKey("printerName");

    if (!printerName) {
      return res.status(400).send({ success: false, error: "Printer Name is not configured or provided" });
    }

    const result = await printService.printJSON(body, printerName);
    return res.send(result);
  } catch (e) {
    logger.error({
      level: "error",
      message: `Print API failed: ${e.message}`,
    });
    return res.status(500).send({ success: false, error: e.message });
  }
});

/*
Start the service (with license validation)
*/
let server;

// --- Terminal connection resiliency -------------------------------------
// nets-service-sdk's checkPortConnection() is fire-and-return: when the OS
// still lists the configured COM port but the SDK's in-process handle isn't
// open, it kicks off an async re-init (SerialPort open takes ~1.5s+) and
// returns failure immediately, without waiting for that re-init to finish.
// So the very first request after any disconnect blip always reported
// "not connected" even though the port was about to recover a moment
// later — and every socket/AMQ handler below used to call sentToTerminal()
// directly with no connectivity check at all (only the two HTTP routes
// further down had one). That matters because sentToTerminal() does not
// return after reporting a connection failure internally — it falls
// through and writes to the closed/null port regardless, which is what
// actually produced the ~60s waits users saw: the SDK's data timeout only
// starts once a byte is written and ACKed, so a write that lands on a port
// that's mid-reconnect (or not open at all) leaves the caller hanging on
// the full 60s timeout instead of failing fast. ensureTerminalConnected()
// gives the SDK's own re-init a short window to actually finish before we
// decide the terminal truly isn't there, and every caller below now checks
// this FIRST and skips sentToTerminal() entirely when it fails.
const PORT_RECOVERY_POLL_MS = 300;
// How long to wait for an in-flight initialize() to open the port.
// The SDK's openPort() always waits 1500ms before calling .open(), then the
// OS itself can take another 500–1500ms to actually open a USB-serial device
// after a power cycle or system restart, then if a Windows Error 31 fires the
// SDK waits an additional 2000ms and retries once.  Worst-case round trip is
// therefore ~5500ms.  3000ms (the old value) was reliably shorter than that,
// which caused ensureTerminalConnected() to give up and return "not connected"
// while initialize() was still in flight and would have succeeded a moment
// later.  8000ms gives a comfortable 2.5s margin over the worst-case path
// without making interactive check-status feel sluggish (the happy path still
// resolves in under a second because we poll every 300ms and return the
// moment global.port.isOpen flips true).
const PORT_RECOVERY_TIMEOUT_MS = 8000;

// A machine that was ever set up with the older NSSM-based installer (see
// source/setup.iss — retired, superseded by installer/setup.iss) registered
// a genuine Windows Service named "KioskService" that auto-starts at boot,
// before any user logs in, and opens the same physical COM port this app
// does. If that old service was never removed when the machine was later
// upgraded to this Electron-based app, both processes fight over the same
// port — the old one wins because it starts first, and this process can
// never open it no matter how many times the watchdog retries, since
// retrying an open() against a port another process already holds just
// fails the same way every time. That's indistinguishable from a genuinely
// wedged driver from the app's own side (both show PORT_NOT_OPEN forever),
// but only this one is something we can detect and point at directly. A
// physical unplug/replug can look like it "fixes" this by coincidence — it
// forces a fresh USB attach event, and depending on timing that can knock
// the *other* process's handle loose long enough for this one to grab it.
const LEGACY_SERVICE_NAME = "KioskService";
const LEGACY_SERVICE_CHECK_TTL_MS = 60000;
let legacyServiceCache = { checkedAt: 0, running: false, stopAttempted: false };

function queryLegacyServiceRunning() {
  return new Promise((resolve) => {
    execFile("sc.exe", ["query", LEGACY_SERVICE_NAME], (err, stdout) => {
      // A non-zero exit (service not registered at all) is the common,
      // healthy case — not a conflict.
      if (err) return resolve(false);
      resolve(/STATE\s*:\s*\d+\s*RUNNING/i.test(stdout || ""));
    });
  });
}

async function checkLegacyServiceConflict() {
  const now = Date.now();
  if (now - legacyServiceCache.checkedAt < LEGACY_SERVICE_CHECK_TTL_MS) {
    return legacyServiceCache.running;
  }
  legacyServiceCache.checkedAt = now;
  legacyServiceCache.running = await queryLegacyServiceRunning();

  if (legacyServiceCache.running) {
    logger.error({
      level: "error",
      message: `⚠️ Legacy "${LEGACY_SERVICE_NAME}" Windows Service is running and may be holding the terminal's COM port — this is a leftover from an older install. Attempting a one-time automatic stop; if this machine's account lacks the rights, run "sc stop ${LEGACY_SERVICE_NAME}" and "sc delete ${LEGACY_SERVICE_NAME}" as Administrator once to clear it permanently.`,
    });

    // Best-effort, once per process lifetime — sc.exe stop needs admin
    // rights this process may not have (the app installs and runs
    // per-user, not elevated), so this silently no-ops on machines where
    // it can't help. Where it CAN (e.g. the service allows it, or this
    // happens to run elevated), it fixes the conflict outright with no
    // manual step at all.
    if (!legacyServiceCache.stopAttempted) {
      legacyServiceCache.stopAttempted = true;
      execFile("sc.exe", ["stop", LEGACY_SERVICE_NAME], (err) => {
        if (err) {
          logger.warn({
            level: "warn",
            message: `Could not stop legacy "${LEGACY_SERVICE_NAME}" service automatically (likely needs Administrator rights): ${err.message}`,
          });
        } else {
          logger.log({
            level: "info",
            message: `✅ Stopped legacy "${LEGACY_SERVICE_NAME}" service — the terminal port should now be free.`,
          });
        }
      });
    }
  }

  return legacyServiceCache.running;
}

async function ensureTerminalConnected() {
  let portStatus = await netsServiceSdk.communication.checkPortConnection();
  if (portStatus.success) return portStatus;

  // Only PORT_NOT_OPEN means checkPortConnection already kicked off a
  // re-init in the background — worth waiting on. PORT_DISCONNECTED means
  // the OS doesn't see the device at all right now; polling here won't
  // change that any faster than the next check will.
  if (portStatus.error !== "PORT_NOT_OPEN") return portStatus;

  // IMPORTANT: poll global.port.isOpen directly here — a plain, side-
  // effect-free read — instead of calling checkPortConnection() again on
  // every tick. checkPortConnection() unconditionally fires ANOTHER full
  // initialize() every single time it finds the port still not open, with
  // no guard against one already being in flight. Calling it every 300ms
  // therefore used to fire up to ten overlapping initialize() calls within
  // this one 3s window, each tearing down and recreating the real
  // SerialPort object out from under the previous call's still-pending
  // .open() callback. Slamming open/close on real hardware that fast is
  // enough to make some USB-serial chipsets report "Unknown error code 31"
  // (Windows' generic "device not functioning") and stay wedged — turning
  // what should have been one clean 2s-spaced retry (the SDK's own error-31
  // handling) into a self-inflicted storm that a physical replug was
  // needed to clear. global.port is the SDK's own module-scoped variable,
  // set via the bare `global` object, so it's readable here directly —
  // watching it doesn't create a second competing initialize() call the
  // way asking checkPortConnection() again on every tick did.
  const deadline = Date.now() + PORT_RECOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PORT_RECOVERY_POLL_MS));
    if (global.port && global.port.isOpen) {
      return { success: true };
    }
  }

  // Still not open after giving that one re-init a fair, un-thrashed
  // chance. Check (and try to clear) the leading known cause before giving
  // up, so a failure here is actionable instead of a bare "not connected"
  // with no way to tell why. portStatus here is still the original
  // PORT_NOT_OPEN result from the very first check above, which remains
  // accurate — nothing since has changed that.
  await checkLegacyServiceConflict();
  return portStatus;
}

function terminalNotConnectedPayload(request, action, error) {
  // legacyServiceCache is populated by ensureTerminalConnected() above right
  // before this is called on a PORT_NOT_OPEN failure — reading the cache
  // directly here (instead of threading it through every call site) keeps
  // all 7 existing callers unchanged.
  const legacyConflict = error === "PORT_NOT_OPEN" && legacyServiceCache.running;
  return {
    status: "FAILED",
    request,
    action,
    error: error || "PORT_DISCONNECTED",
    message: legacyConflict
      ? `Terminal is not connected. A leftover "${LEGACY_SERVICE_NAME}" service from an older install appears to be holding the COM port on this machine. Run this machine's installer once as Administrator to clear it, or manually stop/remove the "${LEGACY_SERVICE_NAME}" Windows Service.`
      : "Terminal is not connected.",
  };
}

// The physical terminal reaches the NETS/bank host over its own network
// path (independent of the USB/serial link checked by ensureTerminalConnected
// above). When that path is down, the terminal itself doesn't fail fast —
// it runs through its own internal host-connect retry policy first, which
// can take minutes before it finally reports back over the serial cable.
// internetMonitor already detects a dead connection in ~10-15s (see
// src/internet-monitor.js), so checking it here before writing anything to
// the terminal turns that multi-minute wait into an near-instant, clearly
// labeled failure instead. Only gates LOGON/PAYMENT, which are the two
// operations that actually need to reach the host — STATUS_CHECK just
// queries the terminal's own local readiness and doesn't.
function noInternetPayload(request, action) {
  return {
    status: "FAILED",
    request,
    action,
    error: "NO_INTERNET",
    message: "The NETS terminal machine has no internet connection. Check the network/router on that machine and try again.",
  };
}

// nets-service-sdk doesn't attach a human-readable "message" to every
// failure it reports itself — e.g. the ACK/NACK timeout in
// src/payment/communication.js just emits { status: "FAILED", action:
// "TERMINAL_ERROR" } with nothing else, so a client only ever saw a bare
// "FAILED"/"TERMINAL_ERROR" badge with no indication of what to check.
// Fills in a plain-language reason for known failure codes, without
// overwriting a message the SDK (or our own guards above) already set.
const SDK_FAILURE_MESSAGE_FALLBACKS = {
  TERMINAL_ERROR: "The terminal did not respond in time. Check the cable connection and that the terminal is powered on, then try again.",
  CANCELLED: "Payment was cancelled or could not be verified as approved by the terminal.",
  DECLINED: "Payment was declined by the terminal.",
  RECOVERY_LRC_FAILURE: "Payment could not be verified after a communication error. Check the terminal before reprinting.",
  NO_INTERNET: "The NETS terminal machine has no internet connection. Check the network/router on that machine and try again.",
};

function withFailureMessageFallback(data) {
  if (!data || data.message || data.status === "SUCCESS" || data.status === "INITIATED") return data;
  const fallback = SDK_FAILURE_MESSAGE_FALLBACKS[data.action] || SDK_FAILURE_MESSAGE_FALLBACKS[data.status];
  if (fallback) data.message = fallback;
  return data;
}

/*
Terminal Operation Handlers (for Socket.IO and HTTP)
*/
/**
 * Pure-software simulation — deliberately independent of the SDK's own
 * simulation/simulationPort mechanism (which still opens a real, if fake,
 * serial port) so testing this service needs no COM port configured at
 * all, just this one config.json flag flipped on (via the Configuration
 * page, or directly). Read fresh on every call, not cached at module load,
 * so toggling it in the Configuration page takes effect on the very next
 * status/logon/payment attempt with no restart.
 */
function isSimulationEnabled() {
  return Boolean(configUtil.readConfig().simulation);
}

const terminalHandlers = {
  // Terminal Status Handler
  handleTerminalStatus: async (data) => {
    if (isSimulationEnabled()) {
      logger.log({ level: "info", message: "🧪 [SIMULATION] Terminal status check — reporting SUCCESS with no hardware attached." });
      // Sent synchronously, before websocket-handler.js's generic "request
      // accepted" ack goes back to the caller (it awaits this handler first)
      // — deliberately not delayed like a real terminal round-trip would be.
      // A delay here used to open a window where the ack (which carries no
      // real terminalStatus field) painted the UI "not connected" and the
      // frontend had to wait for this broadcast to correct it; sending it
      // first means the real state always wins the race, every time.
      sendMessage('clientRoom', SDK_EVENTS.STATUS_MESSAGE, {
        status: "SUCCESS",
        action: "COMPLETED",
        request: "status_check",
        simulated: true,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const portStatus = await ensureTerminalConnected();
    if (!portStatus.success) {
      sendMessage('clientRoom', SDK_EVENTS.STATUS_MESSAGE, terminalNotConnectedPayload("status_check", "FAILED_TO_GET_THE_STATUS", portStatus.error));
      return;
    }

    sentToTerminal("STATUS_CHECK");

    // Emit WebSocket event
    wsHandler.emitTerminalStatus({
      action: "STATUS_CHECK",
      timestamp: new Date().toISOString(),
      ...data,
    });
  },

  // Terminal Logon Handler
  handleTerminalLogon: async (data) => {
    if (isSimulationEnabled()) {
      logger.log({ level: "info", message: "🧪 [SIMULATION] Terminal logon — reporting SUCCESS with no hardware attached." });
      // See the matching comment in handleTerminalStatus above — sent
      // synchronously so the real state is always what the frontend sees
      // first, never a stale/racy generic ack.
      sendMessage('clientRoom', SDK_EVENTS.LOGON_MESSAGE, {
        status: "SUCCESS",
        action: "COMPLETED",
        request: "logon",
        simulated: true,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (internetMonitor.isOnline === false) {
      sendMessage('clientRoom', SDK_EVENTS.LOGON_MESSAGE, noInternetPayload("logon", "NO_INTERNET"));
      return;
    }

    const portStatus = await ensureTerminalConnected();
    if (!portStatus.success) {
      sendMessage('clientRoom', SDK_EVENTS.LOGON_MESSAGE, terminalNotConnectedPayload("logon", "FAILED_TO_LOGON", portStatus.error));
      return;
    }

    sentToTerminal("LOGON");

    // Emit WebSocket event
    wsHandler.emitTerminalLogon({
      action: "LOGON",
      timestamp: new Date().toISOString(),
      ...data,
    });
  },

  // Terminal Payment Handler
  handleTerminalPayment: async (paymentData) => {
    if (isSimulationEnabled()) {
      const orderId = paymentData.orderId || paymentData.reference;
      if (orderId) {
        try {
          paymentTracker.beginPayment(orderId);
        } catch (err) {
          sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
            status: "FAILED",
            action: "TERMINAL_ERROR",
            message: err.message,
            orderId,
          });
          return;
        }
      }

      logger.log({ level: "info", message: `🧪 [SIMULATION] NETS payment for order ${orderId} — auto-completing as SUCCESS in ~1.5s.` });
      sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
        status: "INITIATED",
        action: "PAYMENT_INITIATED",
        orderId,
      });

      setTimeout(() => {
        // approvalCode/retrievalReferenceNumber must be non-empty and not
        // all-zeros — see paymentOutcomes.js's isGenuinelyApproved(), the
        // same check a real terminal's response has to pass before this
        // service will confirm the booking or print a ticket.
        const approvalCode = String(100000 + Math.floor(Math.random() * 900000));
        sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
          status: "SUCCESS",
          action: "COMPLETED",
          orderId,
          simulated: true,
          response: {
            translated: {
              status: "APPROVED",
              responsetext: "SIMULATED APPROVAL",
              amount: paymentData.amount,
              approvalCode,
              retrievalReferenceNumber: approvalCode.padStart(12, "0"),
              cardType: "SIMULATED",
            },
          },
        });
      }, 1500);
      return;
    }

    if (internetMonitor.isOnline === false) {
      sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
        ...noInternetPayload("payment", "NO_INTERNET"),
        orderId: paymentData.reference || paymentData.orderId,
      });
      return;
    }

    const portStatus = await ensureTerminalConnected();
    if (!portStatus.success) {
      sendMessage('clientRoom', SDK_EVENTS.PAYMENT_MESSAGE, {
        status: "FAILED",
        action: "TERMINAL_ERROR",
        error: portStatus.error,
        message: "Terminal is not connected.",
        orderId: paymentData.reference || paymentData.orderId,
      });
      return;
    }

    // Track this order as awaiting a real terminal result, so the receipt
    // print step can later verify what the terminal actually said (see
    // printService.printJSON / SDK_EVENTS.PAYMENT_MESSAGE listener below).
    // Throws if a previous payment is still unresolved — see
    // amq/paymentOutcomes.js for why that has to block here.
    //
    // This MUST run before touching netsServiceSdk.responseHandler's
    // setPaymentCloudUrl/setPaymentOrderId below. Those write into the SDK's
    // module-level globals (there is only ever one "current" order for the
    // whole process), which the SDK reads when the terminal's response
    // eventually arrives to tag the cloud POST. If a second, overlapping
    // payment attempt were allowed to call setPaymentOrderId before being
    // rejected here, it would permanently overwrite the id for whichever
    // order is genuinely still in flight — so when that order's real
    // terminal approval comes back, the SDK stamps the cloud confirmation
    // with the wrong (rejected, never-sent-to-terminal) order's id instead.
    // That leaves the real payment's booking stuck Pending forever while a
    // completely different order gets wrongly confirmed. Checking
    // beginPayment() first ensures a rejected attempt never reaches the SDK
    // calls at all.
    if (paymentData.orderId) {
      paymentTracker.beginPayment(paymentData.orderId);
    }

    // Durable, on-disk record of "this order is now awaiting a terminal
    // result" — survives a process crash, unlike paymentTracker's in-memory
    // state above. If the service dies and restarts before the terminal's
    // result arrives, startup uses this to ask the terminal what actually
    // happened instead of silently losing the confirmation. Cleared once a
    // final result is recorded (see the PAYMENT_MESSAGE handling below).
    pendingPayment.beginTracking(
      paymentData.orderId,
      paymentData.cloud_url || fw.getConfigByKey("cloud_url"),
    );

    // Pass cloud_url and orderId from request to responseHandler for use when response arrives
    if (paymentData.cloud_url) {
      netsServiceSdk.responseHandler.setPaymentCloudUrl(paymentData.cloud_url);
    }
    if (paymentData.orderId) {
      netsServiceSdk.responseHandler.setPaymentOrderId(paymentData.orderId);
    }

    sentToTerminal(paymentData.isCreditTxn ? "CREDIT_PAYMENT" : "PAYMENT", paymentData);

    // Emit WebSocket event
    wsHandler.emitTerminalPayment({
      ...paymentData,
      action: paymentData.isCreditTxn ? "CREDIT_PAYMENT" : "PAYMENT",
      timestamp: new Date().toISOString(),
    });
  },

  // Terminal Receipt Handler
  handleTerminalReceipt: async (receiptData) => {
    const printService = require("./amq/printService");
    const { orderId, receiptData: data, printerName } = receiptData;

    // Use printer from request or fallback to config
    const printer = printerName || fw.getConfigByKey("printerName");

    if (!printer) {
      throw new Error("Printer Name is not configured or provided");
    }

    logger.log({
      level: "info",
      message: `🖨️ Printing receipt for order: ${orderId}`,
    });

    // The card-payment-was-actually-approved check now lives inside
    // printService.printJSON itself (see amq/printService.js), so it
    // applies no matter which route reaches the printer — not just this
    // one. It throws (and this call rejects) if the order isn't a
    // confirmed SUCCESS.
    const result = await printService.printJSON(data, printer, { orderId });

    if (!result.success) {
      throw new Error(result.error || "Print failed");
    }

    return result;
  },

  // Print Ticket Handler — the frontend's own single trigger point for
  // printing a booking's ticket, for every payment mode, called once a
  // booking is fully paid (see PosPortalPage.tsx's printTicketForBooking).
  // Takes the raw ticket-groups object SSD-Backend already resolved (GET
  // .../ticket-groups), not a pre-built receipts[] payload — ticketPrinter.js
  // owns that mapping so it's never duplicated in the frontend.
  //
  // skipApprovalCheck: true — this call only ever happens for a booking
  // SSD-Backend has ALREADY confirmed fully paid, and its paymentMethod can
  // legitimately combine several installments collected over separate
  // terminal charges (e.g. "CASH, NETS") — the in-memory terminal-approval
  // tracker (paymentOutcomes.js) has no way to usefully attest to that, and
  // is keyed by each charge's own fresh per-attempt reference anyway, never
  // this booking's stable orderId — so it would incorrectly refuse to print
  // a payment that genuinely landed. See printService.js's assertPrintAllowed
  // for the full reasoning.
  handlePrintTicket: async (data) => {
    const { orderId, ticketData, paymentMethod } = data;
    // A deliberate reprint from the Transactions screen: prints a "REPRINT #n" banner, always prints (skips the
    // printed-once protection) and, like every print-ticket call, skips the live terminal-approval check.
    const isReprint = data.isReprint === true;
    const reprintNumber = Number(data.reprintNumber) > 0 ? Number(data.reprintNumber) : undefined;
    const config = configUtil.readConfig();
    const printer = data.printerName || config.printerName;

    logger.log({
      level: "info",
      message: `🖨️ Printing ticket for order: ${orderId} (payment method: ${paymentMethod || "unknown"})`,
    });

    // No "printer configured" guard here, unlike handleTerminalReceipt above
    // — ticketPrinter.printTicketGroups() already handles an empty printer
    // name gracefully (renders the debug preview image and queues the
    // ticket for automatic printing once one is set up, see
    // drainPendingPrints()) rather than needing this to refuse up front.
    return ticketPrinter.printTicketGroups(ticketData, printer, {
      paymentMethod: paymentMethod || "CASH",
      orderId,
      gstNumber: config.gstNumber || "",
      skipApprovalCheck: true,
      isReprint,
      reprintNumber,
    });
  },
};

(async () => {
  try {
    // Step 1: Detect machine ID (MAC address) — used only for the license
    // check below, which is itself already non-fatal (see Step 2). No
    // other part of the service depends on this. Previously a missing
    // machine ID (e.g. no network adapter fully up yet at this exact
    // moment — plausible right after a reboot, or transiently on a
    // machine with a slow-to-associate Wi-Fi adapter) killed the entire
    // service via process.exit(1), even though the actual server, sockets,
    // and payment/printing don't need it at all. Downgraded to a warning
    // so a transient network hiccup can no longer take the whole service
    // down over what's ultimately just skipping an optional license ping.
    const machineId = getMachineId();
    if (!machineId) {
      logger.warn({
        level: "warn",
        message: "⚠️ Could not detect machine ID (no active network adapter found) — skipping license check, continuing startup",
      });
    } else {
      logger.log({
        level: "info",
        message: `🔑 Machine ID detected: ${machineId}`,
      });
    }

    // Step 2: Validate license with the license server. Fired without
    // blocking startup — validateLicense makes two sequential network
    // calls (register + verify), each with its own 15s timeout, so on a
    // machine where networking isn't fully up yet right after a reboot,
    // awaiting it here could alone exceed electron/main.js's 15s
    // readiness-check window before the HTTP server even started
    // listening below, causing "Service did not start within timeout" —
    // even though the service would have come up fine a few seconds
    // later. License validation still runs and still logs exactly as
    // before; it just no longer gates server startup. Skipped entirely
    // (not just non-blocking) when there's no machine ID to validate with.
    (machineId ? validateLicense(machineId, logger) : Promise.resolve(false))
      .then((isLicensed) => {
        if (!isLicensed) {
          logger.warn({
            level: "warn",
            message: "⚠️ License validation failed - continuing in unlicensed mode",
          });
        }
      })
      .catch((err) => {
        logger.error({ level: "error", message: `License validation threw: ${err.message}` });
      });


    // Track when the currently-running build first started, as a proxy for
    // "when was this update actually installed" — there's no better single
    // moment to capture it, since the installer itself runs after this
    // process has already exited (see electron/main.js installSilentlyAndRelaunch).
    try {
      const pkgVersion = require("./package.json").version;
      const previousConfig = configUtil.readConfig();
      if (previousConfig.lastKnownVersion !== pkgVersion) {
        configUtil.updateConfig({
          lastKnownVersion: pkgVersion,
          lastUpdateInstalledAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.error({ level: "error", message: `Failed to record installed-version timestamp: ${err.message}` });
    }

    // Step 3: Start the server
    const pkg = require("./package.json");
    // The desktop wrapper provides PORT=2003. Keep the standalone service on
    // the same port by default, rather than accidentally joining an old 5200
    // service instance.
    const listenPort = process.env.PORT || process.env.port || 2003;
    server = app.listen(listenPort, () => {
      logger.log({
        level: "info",
        message: `============================================================`,
      });
      logger.log({
        level: "info",
        message: `🚀 Kiosk Service v${pkg.version} started`,
      });
      logger.log({
        level: "info",
        message: `📦 SDK version: ${netsServiceSdk.version || "1.1.16"}`,
      });
      logger.log({
        level: "info",
        message: `📡 Express server listening on port ${listenPort}`,
      });
      logger.log({
        level: "info",
        message: `============================================================`,
      });

      // One consolidated block covering canvas/Tamil/DLL health, so a
      // failure on any given machine is diagnosable straight from
      // log\service-stdout.log without needing hands-on access to it.
      // Also available live at GET /api/diagnostics/native.
      const diag = getNativeDiagnostics();
      logger.log({
        level: "info",
        message: `🔎 NATIVE DIAGNOSTICS: canvas loaded=${diag.canvas.loaded}${diag.canvas.error ? ` error="${diag.canvas.error}"` : ""} | font registered=${diag.canvas.fontRegistered} | fontconfig=${diag.fontconfig.configuredPath || `FAILED (${diag.fontconfig.configureError})`} | addonsDir=${diag.paths.canvasAddonsDir} | fontsDir=${diag.paths.fontsDir} | runningAs=${diag.runningAs} | platform=${diag.platform}`,
      });
      logger.log({
        level: "info",
        message: `============================================================`,
      });
    });

    /*
    Socket Connection
    */
    global.io = socket(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    // Initialize WebSocket handler
    wsHandler.initialize(global.io);

    // Start Internet connectivity monitor
    internetMonitor.start();

    // Catch up on any tickets queued while no printer was configured yet —
    // covers a service restart that happened between a printer being set up
    // and the queue actually being drained (see ticketPrinter.js).
    {
      const startupConfig = configUtil.readConfig();
      if (startupConfig.printerName) {
        ticketPrinter.drainPendingPrints(startupConfig.printerName).catch((err) => {
          logger.error({ level: "error", message: `Startup pending-print queue drain failed: ${err.message}` });
        });
      }
    }

    // Proactively poll the terminal connection instead of only checking it
    // reactively when a request comes in. Previously, nothing ever retried
    // the port on its own outside of a live request — a serial driver
    // blip, the terminal being unplugged/replugged, or any port-open
    // failure other than the SDK's own narrow "Error 31" case left the
    // port marked not-open until either a request happened to trigger
    // ensureTerminalConnected() above, or (in practice, since nobody
    // reliably did that) the whole machine got rebooted, which re-enumerates
    // the USB/serial device from scratch. This closes that gap: it keeps
    // retrying independently of traffic, so by the time a customer starts a
    // transaction the port has usually already recovered, and it
    // broadcasts a real STATUS_MESSAGE on every state change so the
    // POS/Kiosk "Terminal" badge — which already listens for that event —
    // reflects reality without anyone pressing "Check Status".
    const TERMINAL_WATCHDOG_INTERVAL_MS = 20000;
    // Delay the very first watchdog tick so it doesn't fire while the startup
    // initialize() call is still in flight.  initialize() waits 1500ms before
    // calling .open(), the open itself can take another ~1s, and if an Error 31
    // fires the SDK waits 2s more and retries — total worst-case ~5.5s.
    // Starting the watchdog after 10s gives startup a clean settling window,
    // so the first tick always sees a stable (open or genuinely failed) state
    // instead of a transient PORT_NOT_OPEN that would kick off a second
    // competing initialize() on top of the one already running.
    const TERMINAL_WATCHDOG_STARTUP_DELAY_MS = 10000;
    let lastKnownPortOpen = null;
    const runWatchdog = async () => {
      // This watchdog exists to monitor a REAL serial/USB terminal port —
      // meaningless (and actively harmful) in simulation mode, where there
      // is no port to watch. Left ungated, it called the real
      // ensureTerminalConnected() every 20s regardless, which (a) logged a
      // "Port is NOT connected" error every tick since no hardware exists,
      // and (b) broadcast a genuine CONNECTION_LOST STATUS_MESSAGE to
      // 'clientRoom' the first time it ran after startup — silently
      // stomping the simulated "online" status shortly after boot, which
      // is exactly the kind of unexplained flip to "not connected" this
      // was mistaken for a frontend timing bug.
      if (isSimulationEnabled()) return;
      try {
        const portStatus = await ensureTerminalConnected();
        const nowOpen = portStatus.success;
        if (nowOpen === lastKnownPortOpen) return;

        logger.log({
          level: "info",
          message: `🔌 Terminal connection watchdog: state changed to ${nowOpen ? "CONNECTED" : "DISCONNECTED"}`,
        });

        if (nowOpen) {
          // Port just came back — ask the terminal for a real status so
          // the frontend badge gets an authentic SDK response instead of
          // a synthetic one.
          sentToTerminal("STATUS_CHECK");
        } else {
          sendMessage('clientRoom', SDK_EVENTS.STATUS_MESSAGE, terminalNotConnectedPayload("status_check", "CONNECTION_LOST", portStatus.error));
        }

        lastKnownPortOpen = nowOpen;
      } catch (err) {
        logger.error({ level: "error", message: `Terminal connection watchdog error: ${err.message}` });
      }
    };
    setTimeout(() => {
      // First tick runs after the startup settle delay, then continues on the
      // regular interval so the watchdog keeps monitoring indefinitely.
      runWatchdog();
      setInterval(runWatchdog, TERMINAL_WATCHDOG_INTERVAL_MS);
    }, TERMINAL_WATCHDOG_STARTUP_DELAY_MS);

    // One-shot startup recovery check: if the service died mid-payment
    // (crash, force-kill, anything) and just came back up, paymentTracker's
    // in-memory record of "order X is awaiting a result" is gone, but
    // pendingPayment.js's on-disk marker survives. Ask the terminal
    // directly what happened to its last transaction instead of silently
    // leaving that payment's confirmation lost — the terminal remembers
    // its own last result independently of whether this process was even
    // running to hear it the first time.
    //
    // Deliberately a longer, separate delay from the watchdog's above
    // rather than reusing it: the SDK itself also auto-fires one STATUS_CHECK
    // ~1s after the port opens, and triggerRecovery() unconditionally
    // overwrites the SDK's shared `requestType` state to "RECOVERY" the
    // moment it's called. If that startup status check were still
    // in-flight when this fires, its response would get misrouted through
    // the recovery parser instead of the status parser. In practice that
    // status check reliably completes in ~1.5-2s (confirmed from real
    // logs), so this delay gives it a wide, deliberately generous margin
    // rather than sharing a timing budget with an unrelated check.
    const STARTUP_RECOVERY_CHECK_DELAY_MS = 16000;
    setTimeout(async () => {
      const recoverable = pendingPayment.getRecoverable();
      if (!recoverable) return;

      const portStatus = await ensureTerminalConnected();
      if (!portStatus.success) {
        logger.error({
          level: "error",
          message: `⚠️ Found a payment (order ${recoverable.orderId}) awaiting recovery, but the terminal isn't connected yet — will not retry automatically; check this order manually if it doesn't resolve.`,
        });
        return;
      }

      logger.log({
        level: "info",
        message: `🔎 Found an unresolved payment from before this restart (order ${recoverable.orderId}) — asking the terminal what actually happened.`,
      });

      try {
        paymentTracker.beginPayment(recoverable.orderId);
        if (recoverable.cloudUrl) {
          netsServiceSdk.responseHandler.setPaymentCloudUrl(recoverable.cloudUrl);
        }
        netsServiceSdk.responseHandler.setPaymentOrderId(recoverable.orderId);
        triggerRecovery();
      } catch (err) {
        logger.error({ level: "error", message: `Startup payment recovery failed to start: ${err.message}` });
      }
    }, STARTUP_RECOVERY_CHECK_DELAY_MS);

    // Register handler functions with WebSocket handler
    wsHandler.setHandlers(terminalHandlers);

    // nets-service-sdk has no public API to observe its own STATUS_MESSAGE /
    // LOGON_MESSAGE / PAYMENT_MESSAGE events server-side — `getSocket` was
    // never a real export on this SDK (confirmed against
    // node_modules/nets-service-sdk/dist/index.js), so `sdkSocket` here was
    // always undefined and this whole block never ran. In practice the SDK
    // only ever calls `sendMessage("clientRoom", tag, msg)`, which just does
    // `global.io.emit(tag, msg)` — a one-way broadcast straight to connected
    // browser clients. That's why the frontend always saw payment results
    // fine, while paymentTracker.recordFinalOutcome() — the one thing that's
    // supposed to flip a card order from PENDING to SUCCESS before printing
    // is allowed — was never called. Every card payment (NETS/credit) has
    // been printing "Refusing to print... status: PENDING)" ever since,
    // silently, for every deployment of this SDK version. Cash/PayNow orders
    // never hit this check at all (see paymentOutcomes.js isCardPayment),
    // which is why POS printing looked fine — POS just happened to be
    // tested with cash.
    //
    // Fix: intercept at the one place the SDK's result actually surfaces —
    // the emit call itself — so recordFinalOutcome sees the real terminal
    // outcome the moment it happens, same as before, just via a channel
    // that's actually real.
    const originalIoEmit = global.io.emit.bind(global.io);
    global.io.emit = (event, ...args) => {
      const data = args[0];

      if (data && (event === SDK_EVENTS.PAYMENT_MESSAGE || event === SDK_EVENTS.STATUS_MESSAGE || event === SDK_EVENTS.LOGON_MESSAGE)) {
        withFailureMessageFallback(data);
      }

      if (event === SDK_EVENTS.PAYMENT_MESSAGE && data) {
        logger.log({
          level: "info",
          message: `💳 SDK PAYMENT_MESSAGE: ${JSON.stringify(data)}`,
        });
        // Record the *real* terminal outcome against the order that is
        // currently awaiting a result (the SDK itself does not echo
        // orderId on this event — see amq/paymentOutcomes.js for the
        // correlation logic and its single-flight safeguard).
        let outcome = null;
        try {
          outcome = paymentTracker.recordFinalOutcome(data);
        } catch (err) {
          logger.error({ level: "error", message: `Failed to record payment outcome: ${err.message}` });
        }

        // A final result was just recorded for whichever order was pending
        // (success, decline, cancel, or a recovered result from the
        // startup recovery check below) — nothing left to recover, so the
        // durable marker can go. Runs regardless of outcome.genuinelyApproved:
        // even a confirmed decline means there's no lost confirmation to
        // chase anymore.
        if (outcome) {
          pendingPayment.clear();
        }

        // Refusing to PRINT locally isn't enough on its own — the terminal's
        // raw "SUCCESS" was still about to be broadcast unchanged to every
        // connected kiosk/POS client, which is what let a booking get
        // confirmed on the frontend even though this service already knew
        // it wasn't a real approval (see paymentOutcomes.js). Correct the
        // message at the source instead of relying on every frontend to
        // separately re-implement the same check — this way ANY client,
        // present or future, sees an honest decline.
        if (outcome && data.status === "SUCCESS" && !outcome.genuinelyApproved) {
          const translated = data.response?.translated || {};
          data._rawStatus = data.status;
          data._rawAction = data.action;
          data.status = "FAILED";
          data.action = "DECLINED";
          data.message = `Payment could not be verified as approved by the terminal (${translated.responsetext || "no valid approval code"}) — treating as failed.`;
          args[0] = data;
        }

        // Automatic SSD-Backend confirmation — only for a GENUINELY approved
        // NETS payment (never the raw/unverified "SUCCESS" the terminal
        // itself reported). Ticket printing is NOT done here — see
        // confirmNetsPayment's own comment for why that moved to being the
        // POS Portal frontend's sole responsibility. Deliberately not
        // awaited: this handler is a synchronous override of
        // global.io.emit and must return immediately so the broadcast
        // below isn't delayed by a network round trip; every failure is
        // caught and logged inside confirmNetsPayment itself.
        if (outcome && outcome.genuinelyApproved) {
          confirmNetsPayment(outcome.orderId, data);
        }

        wsHandler.emit(WEBSOCKET_EVENTS.SDK_PAYMENT_MESSAGE, { ...data, sdkEvent: SDK_EVENTS.PAYMENT_MESSAGE });
      } else if (event === SDK_EVENTS.STATUS_MESSAGE && data) {
        logger.log({ level: "info", message: `📊 SDK STATUS_MESSAGE: ${JSON.stringify(data)}` });
        wsHandler.emit(WEBSOCKET_EVENTS.SDK_STATUS_MESSAGE, { ...data, sdkEvent: SDK_EVENTS.STATUS_MESSAGE });
      } else if (event === SDK_EVENTS.LOGON_MESSAGE && data) {
        logger.log({ level: "info", message: `🔐 SDK LOGON_MESSAGE: ${JSON.stringify(data)}` });
        wsHandler.emit(WEBSOCKET_EVENTS.SDK_LOGON_MESSAGE, { ...data, sdkEvent: SDK_EVENTS.LOGON_MESSAGE });
      }

      return originalIoEmit(event, ...args);
    };

    logger.log({
      level: "info",
      message: "✅ SDK payment/status/logon outcome interception wired to global.io.emit",
    });

    // Initialize serial port connection with error handling
    try {
      await initialize(global.io, pkg.version);

      // Attach an error listener to prevent unhandled promise rejections on the SerialPort
      if (global.port && typeof global.port.on === 'function') {
        global.port.on('error', (err) => {
          logger.error({ level: "error", message: `Serial port runtime error: ${err.message}` });
        });
      }

      logger.log({ level: "info", message: "✅ Serial port initialized successfully" });
    } catch (error) {
      logger.error({
        level: "error",
        message: `❌ Serial port initialization failed: ${error.message}`,
      });
      logger.warn({
        level: "warn",
        message: "⚠️  Service will continue without serial port functionality",
      });
    }

  } catch (error) {
    logger.error({
      level: "error",
      message: `❌ Service failed to start due to configuration key failure: ${error.message}`,
    });
    process.exit(1);
  }
})();


// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error({
    level: "error",
    message: `❌ Unhandled Promise Rejection: ${reason}`,
  });
  logger.error({
    level: "error",
    message: `Unhandled Promise Rejection: ${reason}`,
  });
  // Don't exit the process, just log the error
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error({
    level: "error",
    message: `❌ Uncaught Exception: ${error.message}`,
  });
  logger.error({
    level: "error",
    message: `Uncaught Exception: ${error.message}`,
    stack: error.stack,
  });

  // Check if it's a serial port error
  if (error.message && error.message.includes("SerialPort")) {
    logger.warn({
      level: "warn",
      message: "⚠️  Serial port error caught - service will continue",
    });
    logger.warn({
      level: "warn",
      message: "Serial port error caught - service continuing",
    });
    // Don't exit for serial port errors
  } else {
    // For other critical errors, exit gracefully
    if (global.port && global.port.isOpen) {
      try {
        global.port.close();
      } catch (err) {
        // Ignore closing errors on crash
      }
    }
    logger.error({
      level: "error",
      message: "💥 Critical error - shutting down",
    });
    process.exit(1);
  }
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.log({
    level: "info",
    message: `\n🛑 Shutting down gracefully on ${signal}...`,
  });

  // Set a timeout to force exit if graceful shutdown takes too long
  const forceExitTimeout = setTimeout(() => {
    logger.error({
      level: "error",
      message: "⚠️  Forced shutdown after timeout",
    });
    process.exit(1);
  }, 10000); // 10 seconds timeout

  try {
    // Close Serial Port
    if (global.port && global.port.isOpen) {
      logger.log({
        level: "info",
        message: "Closing Serial Port...",
      });
      global.port.close((err) => {
        if (err) {
          logger.error({
            level: "error",
            message: `Error closing Serial Port: ${err.message}`
          });
        }
      });
    }

    // Close AMQ connection
    if (amqConnection) {
      await amqConnection.close();
    }

    // Close Socket.IO connections
    if (global.io) {
      logger.log({
        level: "info",
        message: "Closing Socket.IO connections...",
      });
      global.io.close();
    }

    // Close HTTP server
    if (server) {
      server.close(() => {
        logger.log({
          level: "info",
          message: "✅ Server closed",
        });
        clearTimeout(forceExitTimeout);
        process.exit(0);
      });

      // Force close all connections after a short delay
      setTimeout(() => {
        logger.log({
          level: "info",
          message: "Forcing server connections to close...",
        });
        server.closeAllConnections?.(); // Node.js 18.2+
      }, 2000);
    } else {
      clearTimeout(forceExitTimeout);
      process.exit(0);
    }
  } catch (error) {
    logger.error({
      level: "error",
      message: `Error during shutdown: ${error}`,
    });
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
};

const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
signals.forEach(sig => {
  process.on(sig, () => gracefulShutdown(sig));
});

