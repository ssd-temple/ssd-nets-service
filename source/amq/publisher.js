const logger = require("nets-service-sdk").logger(module);
const { getInstance } = require("./connection");

class AMQPublisher {
    /**
     * Publish a message to the queue
     * @param {Object} message - Message object to publish
     * @param {string} messageType - Type of message (optional, will be added to message)
     */
    async publish(message, messageType = "SERVICE_STATUS") {
        try {
            const connection = getInstance();
            const channel = connection.getChannel();
            const queueName = process.env.AMQ_QUEUE;

            if (!queueName) {
                throw new Error("AMQ_QUEUE not set in environment variables");
            }

            // Assert queue exists (create if not)
            await channel.assertQueue(queueName, {
                durable: true,
            });

            // Add message type if not present
            const messageWithType = {
                ...message,
                type: message.type || messageType,
                timestamp: message.timestamp || new Date().toISOString(),
            };

            const messageContent = JSON.stringify(messageWithType);

            // Publish message
            const sent = channel.sendToQueue(
                queueName,
                Buffer.from(messageContent),
                {
                    persistent: true, // Message survives broker restart
                }
            );

            if (sent) {
                logger.log({
                    level: "info",
                    message: "=".repeat(60) + "\n📤 Message published successfully\n" + "=".repeat(60) + "\n" + messageContent + "\n" + "=".repeat(60),
                });

                logger.log({
                    level: "info",
                    message: `Published message: ${messageContent}`,
                });

                return true;
            } else {
                logger.warn({
                    level: "warn",
                    message: "⚠️  Message not sent (channel buffer full)",
                });
                logger.warn({
                    level: "warn",
                    message: "Message not sent - channel buffer full",
                });
                return false;
            }
        } catch (error) {
            logger.error({
                level: "error",
                message: `❌ Failed to publish message: ${error.message}`,
            });
            logger.error({
                level: "error",
                message: `Failed to publish message: ${error.message}`,
            });
            throw error;
        }
    }

    /**
     * Publish a terminal response message
     */
    async publishTerminalResponse(response, data = {}) {
        return this.publish(
            {
                response,
                data,
            },
            "TERMINAL_RESPONSE"
        );
    }

    /**
     * Publish a service status message
     */
    async publishServiceStatus(status, data = {}) {
        return this.publish(
            {
                status,
                data,
            },
            "SERVICE_STATUS"
        );
    }
}

// Singleton instance
let instance = null;

module.exports = {
    getInstance: () => {
        if (!instance) {
            instance = new AMQPublisher();
        }
        return instance;
    },
};
