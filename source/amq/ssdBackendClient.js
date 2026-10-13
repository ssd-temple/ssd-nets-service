// HTTP bridge from this service to SSD-Backend's automatic NETS payment
// confirmation endpoint (POST /payments/nets/callback — see that
// controller's own module comment for the full architecture). This is
// deliberately the ONLY payment/business logic this service reaches out
// for: it reports a terminal outcome the SDK already resolved and hands
// back whatever ticket data the backend resolved for printing — it does
// not decide approval, does not touch a database, and carries no
// bank/payment-provider logic of its own. See index.js's own comment at
// the call site (the global.io.emit interception) for exactly when this
// fires: only after paymentTracker has already verified a genuine
// terminal approval.

const http = require('http');
const https = require('https');
const axios = require('axios');
const CONSTANTS = require('../constants');
const configUtil = require('../configPath');
const logger = require("nets-service-sdk").logger(module);

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

// A per-install "NETS Callback Secret" field used to live on the
// Configuration page, matched against SSD-Backend's own NETS_CALLBACK_SECRET
// env var — in practice this just meant two independent files that had to
// be kept in sync by hand, and any drift between them (one side's value
// changed, the other forgotten) silently broke every NETS payment
// confirmation until someone noticed the error message. Fixed here instead:
// SSD-Backend's src/config/env.js now carries this exact same string as
// NETS_CALLBACK_SECRET's own default, so there is nothing left to
// configure or keep in sync on either side.
const NETS_CALLBACK_SECRET = 'sdfsfdsfadfsafs';

/**
 * @param {{ referenceId: string, gatewayReference: string, amount?: number, terminalId?: string, approvalCode?: string, terminalResponse?: object }} payload
 * @returns {Promise<{ ticketData: object|null, ticketDataError: string|null, alreadyProcessed?: boolean, [key: string]: any }>}
 *   `ticketData`, when present, is the full { ticketGroups, receipt, temple,
 *   customer, splitMode } shape ready to pass straight into
 *   ticketPrinter.printTicketGroups().
 * @throws if the backend URL/secret aren't configured, or the request itself fails —
 *   the caller (index.js) is responsible for catching this and reporting it
 *   over the existing socket channel without crashing the service.
 */
async function confirmNetsPayment(payload) {
    // Read fresh from config.json/.netConfig on every call (not cached at
    // module load) — "Cloud URL" is the same backend-domain field the
    // Configuration page already exposes for device registration, reused
    // here rather than a second, easy-to-forget "SSD Backend URL" field.
    const config = configUtil.readConfig();
    const backendUrl = config.cloud_url || process.env.URL;
    const callbackSecret = NETS_CALLBACK_SECRET;

    if (!backendUrl) {
        throw new Error('Cannot confirm NETS payment with SSD-Backend — set "Cloud URL" on the Configuration page.');
    }

    const url = `${backendUrl.replace(/\/+$/, '')}${CONSTANTS.API_ENDPOINTS.SSD_NETS_CALLBACK}`;

    logger.log({
        level: 'info',
        message: `Payment confirmation request started: ${url} (referenceId: ${payload.referenceId})`,
    });

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Nets-Callback-Secret': callbackSecret,
            },
            timeout: 15000,
            httpAgent,
            httpsAgent,
        });

        logger.log({
            level: 'info',
            message: `Payment confirmation response received for ${payload.referenceId}: ${response.data?.data?.alreadyProcessed ? 'already processed' : 'confirmed'}`,
        });

        return response.data?.data ?? response.data;
    } catch (error) {
        const detail = error.response?.data?.message || error.message;
        logger.error({
            level: 'error',
            message: `Payment confirmation failed for ${payload.referenceId}: ${detail}`,
        });
        throw new Error(`SSD-Backend payment confirmation failed: ${detail}`);
    }
}

module.exports = { confirmNetsPayment };
