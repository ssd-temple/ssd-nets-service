const axios = require("axios");
const wsHandler = require("../websocket-handler").getInstance();
// We use the logger from established patterns in the project
const logger = require("./winston")(module);

class InternetMonitor {
    constructor() {
        this.interval = 10000; // Check every 10 seconds
        this.timer = null;
        this.isOnline = null; // Initial state unknown
        this.checkUrl = "http://www.google.com/generate_204"; // Classic connectivity check endpoint
    }

    /**
     * Start periodic internet connectivity checks
     */
    start() {
        if (this.timer) return;
        
        logger.log({
            level: "info",
            message: "📡 Internet monitor starting...",
        });

        this.timer = setInterval(() => this.checkConnectivity(), this.interval);
        this.checkConnectivity(); // Run initial check immediately
    }

    /**
     * Stop connectivity checks
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Perform a single connectivity check
     */
    async checkConnectivity() {
        const startTime = Date.now();
        try {
            // Using a HEAD request to minimize data usage
            // We use a short timeout to detect "unstable" connections quickly
            await axios.head(this.checkUrl, { 
                timeout: 5000,
                validateStatus: (status) => status < 500 // Any response < 500 means we reached the internet
            });
            
            const latency = Date.now() - startTime;
            
            // Only log changes to minimize log noise
            if (this.isOnline === false || this.isOnline === null) {
                logger.log({ level: "info", message: `🌐 Internet connection is ONLINE (Latency: ${latency}ms)` });
                this.isOnline = true;
            }
            
            wsHandler.emitInternetStatus(true, latency);
        } catch (error) {
            // Only log changes
            if (this.isOnline === true || this.isOnline === null) {
                logger.error({ 
                    level: "error", 
                    message: `🌐 Internet connection is OFFLINE: ${error.message}` 
                });
                this.isOnline = false;
            }
            
            wsHandler.emitInternetStatus(false);
        }
    }
}

// Export singleton
module.exports = new InternetMonitor();
