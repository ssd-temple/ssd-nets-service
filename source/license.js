const os = require("os");
const http = require("http");
const https = require("https");
const axios = require("axios");

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

const LICENSE_BASE_URL = "https://license.kapzure.com/api";
const PRODUCT_KEY = "7038CBAD6EBB";
const CUSTOMER_ID = "CID-NL1V7DZP";
const PRODUCT_ID = "PID-6IC0JRD2";

/**
 * Get the unique MAC address of the first non-internal network interface.
 * Returns the MAC address string (e.g. "AA:BB:CC:DD:EE:FF") or null if none found.
 */
function getMachineId() {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal (loopback) and interfaces with no MAC
            if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
                return iface.mac;
            }
        }
    }

    return null;
}

/**
 * Register the machine with the license server.
 * @param {string} machineId - The device MAC address
 * @param {object} logger - Optional logger instance
 * @returns {Promise<boolean>} true if registered or already registered (409), false on error
 */
async function registerLicense(machineId, logger) {
    const registerUrl = `${LICENSE_BASE_URL}/register`;
    const payload = {
        productKey: PRODUCT_KEY,
        machineId: machineId,
        customerId: CUSTOMER_ID,
        productId: PRODUCT_ID,
    };

    try {
        if (logger) {
            logger.log({
                level: "info",
                message: `📡 Registering license with server: ${registerUrl}`,
            });
        }

        const response = await axios.post(registerUrl, payload, {
            headers: { "Content-Type": "application/json" },
            timeout: 15000,
            httpAgent,
            httpsAgent,
        });

        if (logger) {
            logger.log({
                level: "info",
                message: `✅ License registered successfully: ${JSON.stringify(response.data)}`,
            });
        }
        return true;
    } catch (error) {
        // 409 = already registered — that's fine
        if (error.response && error.response.status === 409) {
            if (logger) {
                logger.log({
                    level: "info",
                    message: "✅ Machine already registered with this product key",
                });
            }
            return true;
        }

        if (logger) {
            const status = error.response ? error.response.status : "N/A";
            const data = error.response ? JSON.stringify(error.response.data) : error.message;
            logger.error({
                level: "error",
                message: `❌ License registration failed (HTTP ${status}): ${data}`,
            });
        }
        return false;
    }
}

/**
 * Verify the license with the license server.
 * @param {string} machineId - The device MAC address
 * @param {object} logger - Optional logger instance
 * @returns {Promise<boolean>} true if license is valid, false otherwise
 */
async function verifyLicense(machineId, logger) {
    const verifyUrl = `${LICENSE_BASE_URL}/verify`;
    const payload = {
        productKey: PRODUCT_KEY,
        machineId: machineId,
    };

    try {
        if (logger) {
            logger.log({
                level: "info",
                message: `🔍 Verifying license with server: ${verifyUrl}`,
            });
        }

        const response = await axios.post(verifyUrl, payload, {
            headers: { "Content-Type": "application/json" },
            timeout: 15000,
            httpAgent,
            httpsAgent,
        });

        if (response.data && response.data.success === true) {
            if (logger) {
                logger.log({
                    level: "info",
                    message: `✅ License verified: ${response.data.message}`,
                });
            }
            return true;
        }

        if (logger) {
            logger.error({
                level: "error",
                message: `❌ License verification failed: ${JSON.stringify(response.data)}`,
            });
        }
        return false;
    } catch (error) {
        if (logger) {
            const status = error.response ? error.response.status : "N/A";
            const data = error.response ? JSON.stringify(error.response.data) : error.message;
            logger.error({
                level: "error",
                message: `❌ License verification failed (HTTP ${status}): ${data}`,
            });
        }
        return false;
    }
}

/**
 * Full license validation flow: register then verify.
 * @param {string} machineId - The device MAC address
 * @param {object} logger - Optional logger instance
 * @returns {Promise<boolean>} true if license is valid, false otherwise
 */
async function validateLicense(machineId, logger) {
    if (logger) {
        logger.log({
            level: "info",
            message: `🔑 Machine ID: ${machineId}`,
        });
    }

    // Step 1: Register (idempotent — 409 means already registered)
    const registered = await registerLicense(machineId, logger);
    if (!registered) {
        return false;
    }

    // Step 2: Verify the key is valid for this machine
    const verified = await verifyLicense(machineId, logger);
    return verified;
}

module.exports = {
    getMachineId,
    validateLicense,
};
