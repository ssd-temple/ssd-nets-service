const amqp = require("amqplib");
const logger = require("nets-service-sdk").logger(module);
const { AMQ } = require("../constants");

// WebSocket handler will be set after initialization
let wsHandler = null;

// Function to set WebSocket handler
function setWebSocketHandler(handler) {
    wsHandler = handler;
}

class AMQConnection {
    constructor() {
        this.connection = null;
        this.channel = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
    }

    /**
     * Build AMQP connection URL from environment variables
     */
    getConnectionUrl() {
        const protocol = process.env.AMQ_USE_SSL === "true" ? "amqps" : "amqp";
        const host = process.env.AMQ_HOST;
        const port = process.env.AMQ_PORT || (protocol === "amqps" ? 5671 : 5672);
        const user = process.env.AMQ_USER;
        const password = process.env.AMQ_PASSWORD;
        const vhost = process.env.AMQ_VHOST || "/";

        if (!host || !user || !password) {
            return null;
        }

        return `${protocol}://${user}:${password}@${host}:${port}/${vhost}?heartbeat=${AMQ.HEARTBEAT}`;
    }

    /**
     * Connect to AMQ broker
     */
    async connect() {
        try {
            const url = this.getConnectionUrl();

            // Skip AMQ initialization if environment variables are not set
            if (!url) {
                logger.error({
                    level: "error",
                    message: "=".repeat(60) + "\n⚠️  AMQ environment variables not found\n" + "⏭️  Skipping AMQ initialization\n" + "=".repeat(60),
                });

                logger.warn({
                    level: "warn",
                    message: "AMQ_HOST, AMQ_USER, or AMQ_PASSWORD not set. Skipping AMQ initialization.",
                });

                this.isConnected = false;
                return null;
            }

            logger.log({
                level: "info",
                message: "=".repeat(60) + "\n📡 Connecting to AMQ broker...\n" + "=".repeat(60),
            });

            logger.log({
                level: "info",
                message: `Attempting to connect to AMQ at ${process.env.AMQ_HOST}`,
            });

            this.connection = await amqp.connect(url);
            this.channel = await this.connection.createChannel();

            this.isConnected = true;
            this.reconnectAttempts = 0;

            logger.log({
                level: "info",
                message: "✅ Successfully connected to AMQ broker",
            });
            logger.log({
                level: "info",
                message: "Successfully connected to AMQ broker",
            });

            // Emit WebSocket event
            if (wsHandler) {
                wsHandler.emitAMQStatus(true, {
                    host: process.env.AMQ_HOST,
                });
            }

            // Handle connection errors
            this.connection.on("error", (err) => {
                logger.error({
                    level: "error",
                    message: `❌ AMQ connection error: ${err.message}`,
                });
                logger.error({
                    level: "error",
                    message: `AMQ connection error: ${err.message}`,
                });
                this.isConnected = false;

                // Emit WebSocket event
                if (wsHandler) {
                    wsHandler.emitAMQError(err);
                }
            });

            // Handle connection close
            this.connection.on("close", () => {
                logger.warn({
                    level: "warn",
                    message: "⚠️  AMQ connection closed",
                });
                logger.warn({
                    level: "warn",
                    message: "AMQ connection closed",
                });
                this.isConnected = false;
                this.scheduleReconnect();

                // Emit WebSocket event
                if (wsHandler) {
                    wsHandler.emitAMQStatus(false);
                }
            });

            return this.channel;
        } catch (error) {
            logger.error({
                level: "error",
                message: `❌ Failed to connect to AMQ: ${error.message}`,
            });
            logger.error({
                level: "error",
                message: `Failed to connect to AMQ: ${error.message}`,
            });
            this.isConnected = false;
            this.scheduleReconnect();
            throw error;
        }
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= AMQ.MAX_RECONNECT_ATTEMPTS) {
            logger.error({
                level: "error",
                message: `❌ Max reconnection attempts (${AMQ.MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`,
            });
            logger.error({
                level: "error",
                message: `Max reconnection attempts reached`,
            });
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectAttempts++;
        const delay = AMQ.RECONNECT_DELAY;

        logger.log({
            level: "info",
            message: `🔄 Scheduling reconnection attempt ${this.reconnectAttempts}/${AMQ.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
        });
        logger.log({
            level: "info",
            message: `Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`,
        });

        this.reconnectTimer = setTimeout(() => {
            this.connect().catch((err) => {
                logger.error({
                    level: "error",
                    message: `Reconnection failed: ${err.message}`,
                });
            });
        }, delay);
    }

    /**
     * Get the channel
     */
    getChannel() {
        if (!this.isConnected || !this.channel) {
            throw new Error("AMQ not connected. Call connect() first.");
        }
        return this.channel;
    }

    /**
     * Check if connected
     */
    isConnectionActive() {
        return this.isConnected;
    }

    /**
     * Close connection
     */
    async close() {
        try {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
            }

            if (this.channel) {
                await this.channel.close();
            }

            if (this.connection) {
                await this.connection.close();
            }

            this.isConnected = false;
            logger.log({
                level: "info",
                message: "✅ AMQ connection closed gracefully",
            });
            logger.log({
                level: "info",
                message: "AMQ connection closed gracefully",
            });
        } catch (error) {
            logger.error({
                level: "error",
                message: `Error closing AMQ connection: ${error.message}`,
            });
            logger.error({
                level: "error",
                message: `Error closing AMQ connection: ${error.message}`,
            });
        }
    }
}

// Singleton instance
let instance = null;

module.exports = {
    getInstance: () => {
        // delete instance;
        if (!instance) {
            instance = new AMQConnection();
        }
        return instance;
    },
    setWebSocketHandler,
};
