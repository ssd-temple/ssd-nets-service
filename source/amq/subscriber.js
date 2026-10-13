const logger = require("nets-service-sdk").logger(module);
const { getInstance } = require("./connection");
const fw = require("nets-service-sdk").manageConfig;

class AMQSubscriber {
    constructor() {
        this.messageHandlers = new Map();
        this.isSubscribed = false;
    }

    /**
     * Register a message handler for a specific message type
     * @param {string} messageType - Type of message to handle
     * @param {Function} handler - Handler function (message) => void
     */
    registerHandler(messageType, handler) {
        if (typeof handler !== "function") {
            throw new Error("Handler must be a function");
        }

        this.messageHandlers.set(messageType, handler);
        logger.log({
            level: "info",
            message: `📝 Registered handler for message type: ${messageType}`,
        });
        logger.log({
            level: "info",
            message: `Registered handler for message type: ${messageType}`,
        });
    }

    /**
     * Start subscribing to the queue
     */
    async subscribe() {
        try {
            const connection = getInstance();
            const channel = connection.getChannel();
            const queueName = process.env.AMQ_QUEUE;

            if (!queueName) {
                throw new Error("AMQ_QUEUE not set in environment variables");
            }

            // Assert queue exists (create if not)
            await channel.assertQueue(queueName, {
                durable: true, // Queue survives broker restart
            });

            logger.log({
                level: "info",
                message: "=".repeat(60) + `\n📬 Subscribing to queue: ${queueName}\n` + "=".repeat(60),
            });

            logger.log({
                level: "info",
                message: `Subscribing to queue: ${queueName}`,
            });

            // Start consuming messages
            await channel.consume(
                queueName,
                (msg) => {
                    if (msg !== null) {
                        this.handleMessage(msg, channel);
                    }
                },
                {
                    noAck: false, // Manual acknowledgment
                }
            );

            this.isSubscribed = true;
            logger.log({
                level: "info",
                message: "✅ Successfully subscribed to queue",
            });
            logger.log({
                level: "info",
                message: "Successfully subscribed to queue",
            });
        } catch (error) {
            logger.error({
                level: "error",
                message: `❌ Failed to subscribe to queue: ${error.message}`,
            });
            logger.error({
                level: "error",
                message: `Failed to subscribe to queue: ${error.message}`,
            });
            throw error;
        }
    }

    /**
     * Handle incoming message
     */
    handleMessage(msg, channel) {
        try {
            const content = msg.content.toString();
            logger.log({
                level: "info",
                message: "\n" + "=".repeat(60) + "\n📨 Received message:\n" + "=".repeat(60) + "\nMessage: " + msg + "\n" + content + "\n" + "=".repeat(60) + "\n",
            });

            logger.log({
                level: "info",
                message: `Received message: ${content}`,
            });

            // Parse message
            let messageData;
            try {
                messageData = JSON.parse(content);
            } catch (parseError) {
                logger.warn({
                    level: "warn",
                    message: "⚠️  Message is not valid JSON, treating as plain text",
                });
                messageData = { type: "UNKNOWN", data: content };
            }

            // Validate UUID if present in message
            if (messageData.UUID) {
                const deviceUUID = fw.getConfigByKey("device_id");
                if (messageData.UUID !== deviceUUID) {
                    logger.log({
                        level: "info",
                        message: `⏭️  Skipping message - UUID mismatch (expected: ${deviceUUID}, got: ${messageData.UUID})`,
                    });
                    logger.log({
                        level: "info",
                        message: `Skipping message - UUID mismatch (expected: ${deviceUUID}, got: ${messageData.UUID})`,
                    });
                    // Acknowledge message but don't process it
                    channel.ack(msg);
                    logger.log({
                        level: "info",
                        message: "✅ Message acknowledged (skipped)\n",
                    });
                    return;
                }
                logger.log({
                    level: "info",
                    message: `✅ UUID validated: ${messageData.UUID}`,
                });
            }

            // Get message type
            const messageType = messageData.type || "UNKNOWN";

            // Call registered handler if exists
            const handler = this.messageHandlers.get(messageType);
            if (handler) {
                logger.log({
                    level: "info",
                    message: `🔧 Executing handler for message type: ${messageType}`,
                });
                handler(messageData);
            } else {
                logger.warn({
                    level: "warn",
                    message: `⚠️  No handler registered for message type: ${messageType}`,
                });
                logger.warn({
                    level: "warn",
                    message: `No handler registered for message type: ${messageType}`,
                });
            }

            // Acknowledge message
            channel.ack(msg);
            logger.log({
                level: "info",
                message: "✅ Message acknowledged\n",
            });
        } catch (error) {
            logger.error({
                level: "error",
                message: `❌ Error handling message: ${error.message}`,
            });
            logger.error({
                level: "error",
                message: `Error handling message: ${error.message}`,
            });

            // Reject message and requeue
            channel.nack(msg, false, true);
        }
    }

    /**
     * Unsubscribe from queue
     */
    async unsubscribe() {
        this.isSubscribed = false;
        logger.log({
            level: "info",
            message: "🔕 Unsubscribed from queue",
        });
        logger.log({
            level: "info",
            message: "Unsubscribed from queue",
        });
    }
}

// Singleton instance
let instance = null;

module.exports = {
    getInstance: () => {
        if (!instance) {
            instance = new AMQSubscriber();
        }
        return instance;
    },
};
