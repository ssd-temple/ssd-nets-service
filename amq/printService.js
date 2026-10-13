const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
// const receiptline = require('receiptline'); // Removed due to SVG issue
const ESCPOSBuilder = require('./ESCPOSBuilder');
const logger = require("nets-service-sdk").logger(module);

const PS_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'Send-RawPrint.ps1');
const TEMP_DIR = path.join(__dirname, '..', 'temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// WebSocket handler will be set after initialization
let wsHandler = null;

// Function to set WebSocket handler
function setWebSocketHandler(handler) {
    wsHandler = handler;
}

class PrintService {

    /**
     * Get list of all printers and their connections
     */
    async getPrinters() {
        const platform = process.platform;

        return new Promise((resolve, reject) => {
            if (platform === 'win32') {
                // Windows: Use PowerShell
                const command = 'powershell';
                const psCommand = 'Get-Printer | Select-Object Name, PortName, DriverName, Shared, ShareName | ConvertTo-Json';
                exec(`${command} -Command "${psCommand}"`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
                    if (error) {
                        logger.error({
                            level: "error",
                            message: `Failed to list printers: ${error.message}`,
                        });
                        return reject(error);
                    }

                    try {
                        const printers = JSON.parse(stdout);
                        const result = Array.isArray(printers) ? printers : [printers];
                        resolve(result);
                    } catch (e) {
                        logger.error({
                            level: "error",
                            message: `Failed to parse printer list: ${e.message}`,
                        });
                        reject(e);
                    }
                });
            } else {
                // macOS/Linux: Use lpstat
                exec('lpstat -p -d', (error, stdout, stderr) => {
                    if (error) {
                        logger.error({
                            level: "error",
                            message: `Failed to list printers: ${error.message}`,
                        });
                        return reject(error);
                    }

                    try {
                        const printers = [];
                        const lines = stdout.split('\n');

                        for (const line of lines) {
                            if (line.startsWith('printer ')) {
                                const match = line.match(/^printer\s+(\S+)/);
                                if (match) {
                                    printers.push({
                                        Name: match[1],
                                        PortName: 'N/A',
                                        DriverName: 'N/A',
                                        Shared: false,
                                        ShareName: null
                                    });
                                }
                            }
                        }

                        resolve(printers);
                    } catch (e) {
                        logger.error({
                            level: "error",
                            message: `Failed to parse printer list: ${e.message}`,
                        });
                        reject(e);
                    }
                });
            }
        });
    }

    /**
     * Print buffer data
     */
    async printBuffer(buffer, printerName) {
        const timestamp = Date.now();
        const tempFilePath = path.join(TEMP_DIR, `printjob_${timestamp}.bin`);
        fs.writeFileSync(tempFilePath, buffer);
        const platform = process.platform;

        return new Promise((resolve, reject) => {
            if (platform === 'win32') {
                // Windows: Use PowerShell script
                const child = spawn('powershell', [
                    '-ExecutionPolicy', 'Bypass',
                    '-File', PS_SCRIPT_PATH,
                    printerName,
                    tempFilePath
                ]);

                let output = '';
                let errorOutput = '';

                child.stdout.on('data', (data) => {
                    output += data.toString();
                });

                child.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                child.on('close', (code) => {
                    // Cleanup temp file
                    try {
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                        }
                    } catch (e) {
                        logger.warn({
                            level: "warn",
                            message: `Failed to delete temp file ${tempFilePath}: ${e.message}`,
                        });
                    }

                    if (code === 0) {
                        logger.log({
                            level: "info",
                            message: `Print job success: ${output.trim()}`,
                        });
                        resolve({ success: true, message: "Print job sent successfully" });
                    } else {
                        logger.error({
                            level: "error",
                            message: `Print job failed (code ${code}): ${errorOutput}`,
                        });
                        reject(new Error(`Print job failed: ${errorOutput || 'Unknown error'}`));
                    }
                });
            } else {
                // macOS/Linux: Use lp command
                const child = spawn('lp', ['-d', printerName, '-o', 'raw', tempFilePath]);

                let output = '';
                let errorOutput = '';

                child.stdout.on('data', (data) => {
                    output += data.toString();
                });

                child.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                child.on('close', (code) => {
                    // Cleanup temp file
                    try {
                        if (fs.existsSync(tempFilePath)) {
                            fs.unlinkSync(tempFilePath);
                        }
                    } catch (e) {
                        logger.warn({
                            level: "warn",
                            message: `Failed to delete temp file ${tempFilePath}: ${e.message}`,
                        });
                    }

                    if (code === 0) {
                        logger.log({
                            level: "info",
                            message: `Print job success: ${output.trim()}`,
                        });
                        resolve({ success: true, message: "Print job sent successfully" });
                    } else {
                        logger.error({
                            level: "error",
                            message: `Print job failed (code ${code}): ${errorOutput}`,
                        });
                        reject(new Error(`Print job failed: ${errorOutput || 'Unknown error'}`));
                    }
                });
            }
        });
    }

    /**
     * Print JSON data formatted with custom ESC/POS builder
     */
    async printJSON(data, printerName) {
        if (!printerName) {
            throw new Error("Printer name is required");
        }

        logger.log({
            level: "info",
            message: `Generating receipt for printer: ${printerName}`,
        });

        const jobId = `print_${Date.now()}`;

        // Emit print started event
        if (wsHandler) {
            wsHandler.emitPrintStarted({
                jobId,
                printerName,
                timestamp: new Date().toISOString(),
            });
        }

        const builder = new ESCPOSBuilder();

        if (typeof data === 'string') {
            // Raw text print
            builder.text(data).cut();
        } else if (data.content) {
            // Raw text in content
            builder.text(data.content).cut();
        } else if (data.receipts && Array.isArray(data.receipts)) {
            // Handle array of receipts
            data.receipts.forEach(r => this.buildReceipt(builder, r));
        } else if (data.receiptId && data.items) {
            // Handle single receipt object
            this.buildReceipt(builder, data);
        } else {
            // Basic default formatter
            this.buildDefaultReceipt(builder, data);
        }

        const buffer = builder.getBuffer();

        try {
            const result = await this.printBuffer(buffer, printerName);

            // Emit print completed event
            if (wsHandler) {
                wsHandler.emitPrintCompleted({
                    jobId,
                    printerName,
                    timestamp: new Date().toISOString(),
                });
            }

            return result;
        } catch (error) {
            // Emit print failed event
            if (wsHandler) {
                wsHandler.emitPrintFailed({
                    jobId,
                    printerName,
                    timestamp: new Date().toISOString(),
                }, error);
            }

            throw error;
        }
    }

    /**
     * Build receipt commands
     */
    buildReceipt(builder, receipt) {
        console.log("data", receipt);
        // Header
        builder
            .align('center')
            .size(1, 1) // Normal size? Or double width? Image looks like Title is bigger
            .style('b')
            .text('RECEIPT')
            .style('normal')
            .size(1, 1) // reset
            .newline()
            .newline();

        // Date
        if (receipt.templeName) {
            builder
                .align('center')
                .size(1, 1)
                .style('b')

                .text(receipt.templeName)
                .newline()
                .size(1, 1)
                .newline();
            // builder.align('center').text(receipt.templeName).style('b').size(1, 1).newline();
        }
        if (receipt.date) {
            builder.align('center').text(receipt.date).newline();
        }

        builder.text('-'.repeat(42)).newline(); // 42 is ~80mm width in Font A (42-48 cols)

        // Items Table
        // 3 cols: Name, Qty, Total
        // Assuming 42 columns total.
        // Qty: 4 chars
        // Total: 10 chars
        // Name: 42 - 4 - 10 = 28 chars
        const cols = [
            { width: 28, align: 'left' },
            { width: 4, align: 'center' },
            { width: 10, align: 'right' }
        ];

        builder
            .style('b')
            .table(cols, [['ITEM', 'QTY', 'AMOUNT']])
            .style('normal')

        builder.text('-'.repeat(42)).newline(); // 42 is ~80mm width in Font A (42-48 cols)

        if (receipt.items && Array.isArray(receipt.items)) {
            const tableData = receipt.items.map(item => [
                item.name || '',
                String(item.quantity || ''),
                String(item.total || '')
            ]);
            builder.table(cols, tableData);
        }

        builder.text('-'.repeat(42)).newline();

        // Summary
        // Total ... Amount
        if (receipt.summary) {
            const colsSum = [
                { width: 20, align: 'left' },
                { width: 22, align: 'right' }
            ];
            builder
                .style('b')
                .size(1, 1)
                .table(colsSum, [['TOTAL', String(receipt.summary.grandTotal || '')]])
                .style('normal')
                .size(1, 1);
        }

        builder.text('-'.repeat(42)).newline();

        if (receipt.payment) {
            const colsSum = [
                { width: 20, align: 'left' },
                { width: 22, align: 'right' }
            ];
            builder
                .style('b')
                .size(1, 1)
                .table(colsSum, [['PAYMENTMETHOD', String(receipt.payment.method || '')]])
                .style('normal')
                .size(1, 1);
        }

        builder.newline().newline();

        // Barcode
        if (receipt.receiptId) {
            builder
                .align('center')
                .barcode(receipt.receiptId)
                .feed(1) // Space between barcode and text
                .text(receipt.receiptId)
                .feed(1); // Space after text
        }

        // Feed 3 lines to ensure clear cut (3 lines is standard buffer)
        builder.feed(3).cut();
    }

    // Helper to format unstructured JSON
    buildDefaultReceipt(builder, data) {
        builder.align('center').text('Receipt').newline().text('----------------').newline();
        builder.align('left');
        for (const [key, value] of Object.entries(data)) {
            if (typeof value !== 'object') {
                builder.text(`${key}: ${value}`).newline();
            }
        }
        builder.text('----------------').newline().cut();
    }
}

module.exports = new PrintService();
module.exports.setWebSocketHandler = setWebSocketHandler;
