/**
 * Application Constants
 */

module.exports = {
    // API Endpoints
    API_ENDPOINTS: {
        REGISTER_DEVICE: '/api/v1/kiosk/register',
    },

    // AMQ Configuration
    AMQ: {
        RECONNECT_DELAY: 5000, // 5 seconds
        MAX_RECONNECT_ATTEMPTS: 10,
        HEARTBEAT: 60, // 60 seconds
    },

    // Message Types
    MESSAGE_TYPES: {
        TERMINAL_STATUS: 'TERMINAL_STATUS',
        TERMINAL_LOGON: 'TERMINAL_LOGON',
        TERMINAL_PAYMENT: 'TERMINAL_PAYMENT',
        TERMINAL_RESPONSE: 'TERMINAL_RESPONSE',
        SERVICE_STATUS: 'SERVICE_STATUS',
    },

    // WebSocket Events
    WEBSOCKET_EVENTS: {
        // Terminal events
        TERMINAL_STATUS: 'terminal:status',
        TERMINAL_LOGON: 'terminal:logon',
        TERMINAL_PAYMENT: 'terminal:payment',
        TERMINAL_RESPONSE: 'terminal:response',

        // AMQ events
        AMQ_MESSAGE: 'amq:message',
        AMQ_CONNECTED: 'amq:connected',
        AMQ_DISCONNECTED: 'amq:disconnected',
        AMQ_ERROR: 'amq:error',

        // Print events
        PRINT_STARTED: 'print:started',
        PRINT_COMPLETED: 'print:completed',
        PRINT_FAILED: 'print:failed',

        // Service events
        SERVICE_HEALTH: 'service:health',
        SERVICE_ERROR: 'service:error',
        SERVICE_WARNING: 'service:warning',

        // Connection events
        CLIENT_CONNECTED: 'client:connected',
        CLIENT_DISCONNECTED: 'client:disconnected',

        // SDK Socket Events (from nets-service-sdk)
        SDK_STATUS_MESSAGE: 'sdk:status',
        SDK_LOGON_MESSAGE: 'sdk:logon',
        SDK_PAYMENT_MESSAGE: 'sdk:payment',
    },

    // SDK Socket Event Names (what the SDK emits)
    SDK_EVENTS: {
        STATUS_MESSAGE: 'STATUS_MESSAGE',
        LOGON_MESSAGE: 'LOGON_MESSAGE',
        PAYMENT_MESSAGE: 'PAYMENT_MESSAGE',
    },

    // Socket Commands (client-to-server commands)
    SOCKET_COMMANDS: {
        TERMINAL_STATUS: 'terminal:status',
        TERMINAL_LOGON: 'terminal:logon',
        TERMINAL_PAYMENT_NETS: 'terminal:payment:nets',
        TERMINAL_PAYMENT_CREDIT_CARD: 'terminal:payment:credit_card',
        TERMINAL_RECEIPT: 'terminal:receipt',
    },

    // Command Response Types
    COMMAND_RESPONSES: {
        SUCCESS: 'success',
        ERROR: 'error',
        ACKNOWLEDGED: 'acknowledged',
    },

    // Other constants can be added here
    APP_NAME: 'NPService-Kiosk',
    VERSION: '1.0.0',
};
