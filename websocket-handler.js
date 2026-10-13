const logger = require("nets-service-sdk").logger(module);
const { WEBSOCKET_EVENTS, SOCKET_COMMANDS, COMMAND_RESPONSES } = require("./constants");

class WebSocketHandler {
    constructor() {
        this.io = null;
        this.connectedClients = new Map();
        this.handlers = {}; // Store API handler functions
    }

    /**
     * Set handler functions for terminal operations
     */
    setHandlers(handlers) {
        this.handlers = handlers;
        logger.log({
            level: "info",
            message: "Handler functions registered for socket commands",
        });
    }

    /**
     * Initialize WebSocket handler with Socket.IO instance
     */
    initialize(io) {
        this.io = io;
        this.setupEventHandlers();
        logger.log({
            level: "info",
            message: "WebSocket handler initialized",
        });
    }

    /**
     * Setup Socket.IO event handlers
     */
    setupEventHandlers() {
        this.io.on("connection", (socket) => {
            const clientId = socket.id;

            logger.log({
                level: "info",
                message: `WebSocket client connected: ${clientId}`,
            });

            // Store client info
            this.connectedClients.set(clientId, {
                id: clientId,
                connectedAt: new Date(),
                rooms: new Set(),
            });

            // Emit connection event to all clients
            this.emit(WEBSOCKET_EVENTS.CLIENT_CONNECTED, {
                clientId,
                timestamp: new Date().toISOString(),
            });

            // Handle client joining rooms
            socket.on("ADD_CLIENT_SERVICE", (data) => {
                socket.join("clientRoom");

                const clientInfo = this.connectedClients.get(clientId);
                if (clientInfo) {
                    clientInfo.rooms.add("clientRoom");
                }

                logger.log({
                    level: "info",
                    message: `Client ${clientId} joined clientRoom`,
                });

                const clients = this.io.sockets.adapter.rooms.get("clientRoom");
                const numClients = clients ? clients.size : 0;

                logger.log({
                    level: "info",
                    message: `Total clients in clientRoom: ${numClients}`,
                });

                // Send acknowledgment to the client
                socket.emit("room:joined", {
                    room: "clientRoom",
                    clientCount: numClients,
                });
            });

            // Handle admin room
            socket.on("ADD_ADMIN_SERVICE", (data) => {
                socket.join("adminRoom");

                const clientInfo = this.connectedClients.get(clientId);
                if (clientInfo) {
                    clientInfo.rooms.add("adminRoom");
                }

                logger.log({
                    level: "info",
                    message: `Admin ${clientId} joined adminRoom`,
                });

                socket.emit("room:joined", {
                    room: "adminRoom",
                    clientCount: this.io.sockets.adapter.rooms.get("adminRoom")?.size || 0,
                });
            });

            // Handle disconnection
            socket.on("disconnect", (reason) => {
                logger.log({
                    level: "info",
                    message: `WebSocket client disconnected: ${clientId}, reason: ${reason}`,
                });

                this.connectedClients.delete(clientId);

                // Emit disconnection event
                this.emit(WEBSOCKET_EVENTS.CLIENT_DISCONNECTED, {
                    clientId,
                    reason,
                    timestamp: new Date().toISOString(),
                });
            });

            // ========================================
            // Command Listeners
            // ========================================

            // Terminal Status Command
            socket.on(SOCKET_COMMANDS.TERMINAL_STATUS, async (data, callback) => {
                logger.log({
                    level: "info",
                    message: `📊 Received TERMINAL_STATUS command from ${clientId}`,
                });

                try {
                    if (this.handlers.handleTerminalStatus) {
                        await this.handlers.handleTerminalStatus(data);

                        const response = {
                            status: COMMAND_RESPONSES.SUCCESS,
                            message: "Terminal status check initiated",
                            timestamp: new Date().toISOString(),
                        };

                        if (callback) callback(response);
                        socket.emit(`${SOCKET_COMMANDS.TERMINAL_STATUS}:response`, response);
                    } else {
                        throw new Error("Terminal status handler not registered");
                    }
                } catch (error) {
                    logger.error({
                        level: "error",
                        message: `Terminal status command failed: ${error.message}`,
                    });

                    const errorResponse = {
                        status: COMMAND_RESPONSES.ERROR,
                        error: error.message,
                        timestamp: new Date().toISOString(),
                    };

                    if (callback) callback(errorResponse);
                    socket.emit(`${SOCKET_COMMANDS.TERMINAL_STATUS}:response`, errorResponse);
                }
            });

            // Terminal Logon Command
            socket.on(SOCKET_COMMANDS.TERMINAL_LOGON, async (data, callback) => {
                logger.log({
                    level: "info",
                    message: `🔐 Received TERMINAL_LOGON command from ${clientId}`,
                });

                try {
                    if (this.handlers.handleTerminalLogon) {
                        await this.handlers.handleTerminalLogon(data);

                        const response = {
                            status: COMMAND_RESPONSES.SUCCESS,
                            message: "Terminal logon initiated",
                            timestamp: new Date().toISOString(),
                        };

                        if (callback) callback(response);
                        socket.emit(`${SOCKET_COMMANDS.TERMINAL_LOGON}:response`, response);
                    } else {
                        throw new Error("Terminal logon handler not registered");
                    }
                } catch (error) {
                    logger.error({
                        level: "error",
                        message: `Terminal logon command failed: ${error.message}`,
                    });

                    const errorResponse = {
                        status: COMMAND_RESPONSES.ERROR,
                        error: error.message,
                        timestamp: new Date().toISOString(),
                    };

                    if (callback) callback(errorResponse);
                    socket.emit(`${SOCKET_COMMANDS.TERMINAL_LOGON}:response`, errorResponse);
                }
            });

            // Terminal Payment NETS Command
            socket.on(SOCKET_COMMANDS.TERMINAL_PAYMENT_NETS, async (data, callback) => {
                logger.log({
                    level: "info",
                    message: `💳 Received TERMINAL_PAYMENT_NETS command from ${clientId}: ${JSON.stringify(data)}`,
                });

                try {
                    if (!data.amount || !data.currency) {
                        throw new Error("Missing required fields: amount, currency");
                    }

                    if (this.handlers.handleTerminalPayment) {
                        await this.handlers.handleTerminalPayment({
                            ...data,
                            isCreditTxn: false,
                            paymentType: 'NETS',
                        });

                        const response = {
                            status: COMMAND_RESPONSES.SUCCESS,
                            message: "NETS payment initiated",
                            orderId: data.orderId,
                            amount: data.amount,
                            timestamp: new Date().toISOString(),
                        };

                        if (callback) callback(response);
                        socket.emit(`${SOCKET_COMMANDS.TERMINAL_PAYMENT_NETS}:response`, response);
                    } else {
                        throw new Error("Terminal payment handler not registered");
                    }
                } catch (error) {
                    logger.error({
                        level: "error",
                        message: `NETS payment command failed: ${error.message}`,
                    });

                    const errorResponse = {
                        status: COMMAND_RESPONSES.ERROR,
                        error: error.message,
                        timestamp: new Date().toISOString(),
                    };

                    if (callback) callback(errorResponse);
                    socket.emit(`${SOCKET_COMMANDS.TERMINAL_PAYMENT_NETS}:response`, errorResponse);
                }
            });

            // Terminal Payment Credit Card Command
            socket.on(SOCKET_COMMANDS.TERMINAL_PAYMENT_CREDIT_CARD, async (data, callback) => {
                logger.log({
                    level: "info",
                    message: `💳 Received TERMINAL_PAYMENT_CREDIT_CARD command from ${clientId}: ${JSON.stringify(data)}`,
                });

                try {
                    if (!data.amount || !data.currency) {
                        throw new Error("Missing required fields: amount, currency");
                    }

                    if (this.handlers.handleTerminalPayment) {
                        await this.handlers.handleTerminalPayment({
                            ...data,
                            isCreditTxn: true,
                            paymentType: 'CREDIT_CARD',
                        });

                        const response = {
                            status: COMMAND_RESPONSES.SUCCESS,
                            message: "Credit card payment initiated",
                            orderId: data.orderId,
                            amount: data.amount,
                            timestamp: new Date().toISOString(),
                        };

                        if (callback) callback(response);
                        socket.emit(`${SOCKET_COMMANDS.TERMINAL_PAYMENT_CREDIT_CARD}:response`, response);
                    } else {
                        throw new Error("Terminal payment handler not registered");
                    }
                } catch (error) {
                    logger.error({
                        level: "error",
                        message: `Credit card payment command failed: ${error.message}`,
                    });

                    const errorResponse = {
                        status: COMMAND_RESPONSES.ERROR,
                        error: error.message,
                        timestamp: new Date().toISOString(),
                    };

                    if (callback) callback(errorResponse);
                    socket.emit(`${SOCKET_COMMANDS.TERMINAL_PAYMENT_CREDIT_CARD}:response`, errorResponse);
                }
            });

            // Terminal Receipt Command
            socket.on(SOCKET_COMMANDS.TERMINAL_RECEIPT, async (data, callback) => {
                logger.log({
                    level: "info",
                    message: `🖨️ Received TERMINAL_RECEIPT command from ${clientId}: ${JSON.stringify(data)}`,
                });

                try {
                    if (!data.orderId || !data.receiptData) {
                        throw new Error("Missing required fields: orderId, receiptData");
                    }

                    if (this.handlers.handleTerminalReceipt) {
                        await this.handlers.handleTerminalReceipt(data);

                        const response = {
                            status: COMMAND_RESPONSES.SUCCESS,
                            message: "Receipt printing initiated",
                            orderId: data.orderId,
                            timestamp: new Date().toISOString(),
                        };

                        if (callback) callback(response);
                        socket.emit(`${SOCKET_COMMANDS.TERMINAL_RECEIPT}:response`, response);
                    } else {
                        throw new Error("Terminal receipt handler not registered");
                    }
                } catch (error) {
                    logger.error({
                        level: "error",
                        message: `Receipt printing command failed: ${error.message}`,
                    });

                    const errorResponse = {
                        status: COMMAND_RESPONSES.ERROR,
                        error: error.message,
                        timestamp: new Date().toISOString(),
                    };

                    if (callback) callback(errorResponse);
                    socket.emit(`${SOCKET_COMMANDS.TERMINAL_RECEIPT}:response`, errorResponse);
                }
            });
        });
    }

    /**
     * Emit event to all connected clients
     */
    emit(event, data) {
        if (!this.io) {
            logger.warn({
                level: "warn",
                message: "WebSocket not initialized, cannot emit event",
            });
            return;
        }

        this.io.emit(event, {
            ...data,
            timestamp: data.timestamp || new Date().toISOString(),
        });
    }

    /**
     * Emit event to specific room
     */
    emitToRoom(room, event, data) {
        if (!this.io) {
            logger.warn({
                level: "warn",
                message: "WebSocket not initialized, cannot emit to room",
            });
            return;
        }

        this.io.to(room).emit(event, {
            ...data,
            timestamp: data.timestamp || new Date().toISOString(),
        });
    }

    /**
     * Emit terminal status event
     */
    emitTerminalStatus(status) {
        this.emit(WEBSOCKET_EVENTS.TERMINAL_STATUS, {
            status,
            type: "status_check",
        });
    }

    /**
     * Emit terminal logon event
     */
    emitTerminalLogon(data) {
        this.emit(WEBSOCKET_EVENTS.TERMINAL_LOGON, {
            ...data,
            type: "logon",
        });
    }

    /**
     * Emit terminal payment event
     */
    emitTerminalPayment(paymentData) {
        this.emit(WEBSOCKET_EVENTS.TERMINAL_PAYMENT, {
            ...paymentData,
            type: "payment",
        });
    }

    /**
     * Emit terminal response event
     */
    emitTerminalResponse(response) {
        this.emit(WEBSOCKET_EVENTS.TERMINAL_RESPONSE, {
            ...response,
            type: "response",
        });
    }

    /**
     * Emit AMQ message event
     */
    emitAMQMessage(message) {
        this.emit(WEBSOCKET_EVENTS.AMQ_MESSAGE, {
            message,
        });
    }

    /**
     * Emit AMQ connection status
     */
    emitAMQStatus(connected, details = {}) {
        const event = connected
            ? WEBSOCKET_EVENTS.AMQ_CONNECTED
            : WEBSOCKET_EVENTS.AMQ_DISCONNECTED;

        this.emit(event, {
            connected,
            ...details,
        });
    }

    /**
     * Emit AMQ error
     */
    emitAMQError(error) {
        this.emit(WEBSOCKET_EVENTS.AMQ_ERROR, {
            error: error.message || error,
        });
    }

    /**
     * Emit print job started
     */
    emitPrintStarted(jobData) {
        this.emit(WEBSOCKET_EVENTS.PRINT_STARTED, {
            ...jobData,
        });
    }

    /**
     * Emit print job completed
     */
    emitPrintCompleted(jobData) {
        this.emit(WEBSOCKET_EVENTS.PRINT_COMPLETED, {
            ...jobData,
        });
    }

    /**
     * Emit print job failed
     */
    emitPrintFailed(jobData, error) {
        this.emit(WEBSOCKET_EVENTS.PRINT_FAILED, {
            ...jobData,
            error: error.message || error,
        });
    }

    /**
     * Emit service health event
     */
    emitServiceHealth(healthData) {
        this.emit(WEBSOCKET_EVENTS.SERVICE_HEALTH, {
            ...healthData,
        });
    }

    /**
     * Emit service error
     */
    emitServiceError(error, context = {}) {
        this.emit(WEBSOCKET_EVENTS.SERVICE_ERROR, {
            error: error.message || error,
            ...context,
        });
    }

    /**
     * Emit service warning
     */
    emitServiceWarning(warning, context = {}) {
        this.emit(WEBSOCKET_EVENTS.SERVICE_WARNING, {
            warning,
            ...context,
        });
    }

    /**
     * Get connected clients count
     */
    getConnectedClientsCount() {
        return this.connectedClients.size;
    }

    /**
     * Get clients in a specific room
     */
    getRoomClients(room) {
        if (!this.io) return 0;
        const clients = this.io.sockets.adapter.rooms.get(room);
        return clients ? clients.size : 0;
    }
}

// Singleton instance
let instance = null;

module.exports = {
    getInstance: () => {
        if (!instance) {
            instance = new WebSocketHandler();
        }
        return instance;
    },
};
