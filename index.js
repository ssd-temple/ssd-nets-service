require("dotenv").config();
const express = require("express");
const moment = require("moment");
const _ = require("lodash");
const cors = require("cors");
const socket = require("socket.io");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const axios = require("axios");
const netsServiceSdk = require("nets-service-sdk");
const { verifyParser } = netsServiceSdk.responseHandler;
const fw = netsServiceSdk.manageConfig;
const { initialize, sentToTerminal } = netsServiceSdk.communication;
const { sendMessage } = netsServiceSdk;
const audit = require("express-requests-logger");
const logger = netsServiceSdk.logger(module);
const { API_ENDPOINTS, MESSAGE_TYPES, SDK_EVENTS, WEBSOCKET_EVENTS } = require("./constants");
const amq = require("./amq");
const wsHandler = require("./websocket-handler").getInstance();

const printList = [];

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

// Initialize device ID
async function initializeDeviceId() {
  const configPath = path.join(__dirname, "config.json");

  try {
    // Read current config
    const configData = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configData);

    let isNewDevice = false;

    // Check if device_id already exists
    if (!config.device_id) {
      // Generate a unique device ID using UUID v4
      const deviceId = crypto.randomUUID();
      config.device_id = deviceId;
      isNewDevice = true;

      // Write back to config.json
      fs.writeFileSync(configPath, JSON.stringify(config, null, "\t"), "utf8");

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
    amqSubscriber.registerHandler(MESSAGE_TYPES.TERMINAL_STATUS, (message) => {
      logger.log({
        level: "info",
        message: `📊 Processing TERMINAL_STATUS: ${JSON.stringify(message)}`,
      });
      sentToTerminal("STATUS_CHECK");

      // Emit WebSocket event
      sendMessage('clientRoom', 'AMQ_TERMINAL_STATUS', {
        type: MESSAGE_TYPES.TERMINAL_STATUS,
        data: message,
      });
    });

    amqSubscriber.registerHandler(MESSAGE_TYPES.TERMINAL_LOGON, (message) => {
      logger.log({
        level: "info",
        message: `🔐 Processing TERMINAL_LOGON: ${JSON.stringify(message)}`,
      });
      sentToTerminal("LOGON");

      // Emit WebSocket event
      sendMessage('clientRoom', 'AMQ_TERMINAL_LOGON', {
        type: MESSAGE_TYPES.TERMINAL_LOGON,
        data: message,
      });
    });

    amqSubscriber.registerHandler(MESSAGE_TYPES.TERMINAL_PAYMENT, (message) => {
      logger.log({
        level: "info",
        message: `💳 Processing TERMINAL_PAYMENT: ${JSON.stringify(message)}`,
      });
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

app.use(audit());
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

logger.log({
  level: "info",
  message: `Express server started`,
});



/*
Check the Terminal Status
*/
app.post("/terminal/status", async (req, res) => {
  try {
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


app.post("/v2/print", async (req, res) => {
  try {
    const { body } = req;
    if (printList.indexOf(body.entryId) == -1 || body.reprint) {
      printList.push(body.entryId);
      const response = await getOrderDetails(body.entryId);
      const temple = await getTemple(body.templeCode);
      let font = 10;
      if (body.templeCode === "SST") {
        font = 11;
      }
      if (body.templeCode === "SVKT") {
        font = 8.5;
      }
      // const increase = ["SST"].indexOf(body.templeCode) > -1 ? true : false;
      if (response && response.Order && temple) {
        const order = response.Order;
        const itemList = response.itemList;
        const obj = {
          orderId: order.entryId,
          header: [
            `Receipt Id: ${order.entryId}`,
            "GST Regn No:   M881003771",
            `தேதி/Date: ${moment(order.createdAt).format("DD/MM/YYYY hh:mm")}`,
            `${temple.title}`,
          ],
          archanai: [],
          poojai: [],
          total: [
            `${temple.title}`,
            `Receipt Ref:  ${order.orderId}`,
            `$${financial(order.totalAmount)} (GST Inclusive)`,
          ],
          payment: {
            type: "",
            values: [],
          },
        };

        obj.archanai = generateArchanai(order, itemList, body.reprint);
        obj.poojai = generatePoojai(order, itemList, body.reprint);
        obj.charity = generateCharity(order, itemList, body.reprint);
        if (
          order &&
          order.fullfillmentDetails &&
          order.fullfillmentDetails.paymentType == "Nets"
        ) {
          obj.payment = fetchPayment(order);
        }
        segmentedPrint.clearPrivousJobs();
        const time = moment().format("DD/MM/YYYY hh:mm");
        const epoch = new Date().getTime();
        logger.log({
          level: "info",
          message: `Print Job Started ${time}`,
        });
        logger.log({
          level: "info",
          message: `Request:  ${JSON.stringify(req.body)}`,
        });

        _.map(obj.archanai, (value, i) => {
          segmentedPrint.printArchanai(
            value,
            "archanai" + i + "_" + epoch,
            time,
            obj.header,
            obj.orderId,
            font
          );
        });
        _.map(obj.poojai, (value, i) => {
          segmentedPrint.printProduct(
            value,
            "product" + i + "_" + epoch,
            time,
            obj.header,
            obj.orderId,
            font
          );
        });
        _.map(obj.charity, (value, i) => {
          segmentedPrint.printCharity(
            value,
            "charity" + i + "_" + epoch,
            time,
            obj.header,
            obj.orderId,
            font
          );
        });
        return res.send({ message: "print Initiated" });
      } else {
        return res.send({ message: "Failed to Print" });
      }
    } else {
      return res.send({ message: "Print Got Triggered Already" });
    }
  } catch (e) {
    logger.error({
      level: "error",
      message: `${JSON.stringify(e)}`,
    });
    logger.error({
      level: "info",
      message: `print request ${JSON.stringify(e)}`,
    });
    return res.send(e);
  }
});

/*
 Print API Endpoints
*/
const printService = require("./amq/printService");
printService.setWebSocketHandler(wsHandler);

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

// Get current configuration
app.get("/api/config", async (req, res) => {
  try {
    const config = fw.getConfig();
    return res.send({
      success: true,
      config: {
        printerName: config.printerName,
        printerPort: config.printerPort
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
    fw.updateConfig({
      printerName,
      printerPort
    });

    logger.log({
      level: "info",
      message: `Printer configuration updated: ${printerName} (${printerPort})`,
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
Start the service 
*/
const server = app.listen(process.env.port || 5200, () => {
  logger.log({
    level: "info",
    message: `Express server listening on port ${process.env.port || 5200}`,
  });
});

/*
Terminal Operation Handlers (for Socket.IO and HTTP)
*/
const terminalHandlers = {
  // Terminal Status Handler
  handleTerminalStatus: async (data) => {
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

    // Print using the print service
    const result = await printService.printJSON(data, printer);

    if (!result.success) {
      throw new Error(result.error || "Print failed");
    }

    return result;
  },
};

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

// Register handler functions with WebSocket handler
wsHandler.setHandlers(terminalHandlers);

// Listen to SDK socket events and forward to WebSocket clients
// Get the SDK's socket instance
const sdkSocket = netsServiceSdk.getSocket?.();

if (sdkSocket) {
  logger.log({
    level: "info",
    message: "Setting up SDK socket event listeners...",
  });

  // Listen to STATUS_MESSAGE events from SDK
  sdkSocket.on(SDK_EVENTS.STATUS_MESSAGE, (data) => {
    logger.log({
      level: "info",
      message: `📊 SDK STATUS_MESSAGE: ${JSON.stringify(data)}`,
    });

    // Forward to WebSocket clients
    wsHandler.emit(WEBSOCKET_EVENTS.SDK_STATUS_MESSAGE, {
      ...data,
      sdkEvent: SDK_EVENTS.STATUS_MESSAGE,
    });
  });

  // Listen to LOGON_MESSAGE events from SDK
  sdkSocket.on(SDK_EVENTS.LOGON_MESSAGE, (data) => {
    logger.log({
      level: "info",
      message: `🔐 SDK LOGON_MESSAGE: ${JSON.stringify(data)}`,
    });

    // Forward to WebSocket clients
    wsHandler.emit(WEBSOCKET_EVENTS.SDK_LOGON_MESSAGE, {
      ...data,
      sdkEvent: SDK_EVENTS.LOGON_MESSAGE,
    });
  });

  // Listen to PAYMENT_MESSAGE events from SDK
  sdkSocket.on(SDK_EVENTS.PAYMENT_MESSAGE, (data) => {
    logger.log({
      level: "info",
      message: `💳 SDK PAYMENT_MESSAGE: ${JSON.stringify(data)}`,
    });

    // Forward to WebSocket clients
    wsHandler.emit(WEBSOCKET_EVENTS.SDK_PAYMENT_MESSAGE, {
      ...data,
      sdkEvent: SDK_EVENTS.PAYMENT_MESSAGE,
    });
  });

  logger.log({
    level: "info",
    message: "✅ SDK socket event listeners registered",
  });
} else {
  logger.warn({
    level: "warn",
    message: "⚠️  SDK socket not available, skipping SDK event listeners",
  });
}


// Initialize serial port connection with error handling
try {
  initialize();
  logger.log({
    level: "info",
    message: "✅ Serial port initialized successfully",
  });
  logger.log({
    level: "info",
    message: "Serial port initialized successfully",
  });
} catch (error) {
  logger.error({
    level: "error",
    message: `❌ Serial port initialization failed: ${error.message}`,
  });
  logger.warn({
    level: "warn",
    message: "⚠️  Service will continue without serial port functionality",
  });
  logger.error({
    level: "error",
    message: `Serial port initialization failed: ${error.message}`,
  });
  logger.warn({
    level: "warn",
    message: "Service continuing without serial port functionality",
  });
}

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
    logger.error({
      level: "error",
      message: "💥 Critical error - shutting down",
    });
    process.exit(1);
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  logger.log({
    level: "info",
    message: "\n🛑 Shutting down gracefully...",
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
});

