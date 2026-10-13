/**
 * Socket.IO Test Client
 * Tests all terminal command handlers
 */

const io = require('socket.io-client');

// Configuration
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:5200';

// Socket Commands (matching constants.js)
const SOCKET_COMMANDS = {
    TERMINAL_STATUS: 'terminal:status',
    TERMINAL_LOGON: 'terminal:logon',
    TERMINAL_PAYMENT_NETS: 'terminal:payment:nets',
    TERMINAL_PAYMENT_CREDIT_CARD: 'terminal:payment:credit_card',
    TERMINAL_RECEIPT: 'terminal:receipt',
};

console.log('🚀 Socket.IO Test Client');
console.log(`📡 Connecting to: ${SERVER_URL}`);
console.log('='.repeat(60));

// Connect to server
const socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: true,
});

socket.on('connect', () => {
    console.log('✅ Connected to server');
    console.log(`📌 Socket ID: ${socket.id}`);

    // Join client room
    socket.emit('ADD_CLIENT_SERVICE', {});
});

socket.on('room:joined', (data) => {
    console.log(`✅ Joined room: ${data.room}`);
    console.log(`👥 Clients in room: ${data.clientCount}`);
    console.log('='.repeat(60));

    // Start testing after joining room
    setTimeout(() => runTests(), 1000);
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
});

socket.on('connect_error', (error) => {
    console.error('❌ Connection error:', error.message);
    process.exit(1);
});

// Listen to all events
socket.onAny((eventName, data) => {
    if (!eventName.includes('room:joined')) {
        console.log(`\n📨 Event received: ${eventName}`);
        console.log(JSON.stringify(data, null, 2));
    }
});

// Test functions
async function testTerminalStatus() {
    return new Promise((resolve) => {
        console.log('\n📊 Testing TERMINAL_STATUS...');

        socket.emit(SOCKET_COMMANDS.TERMINAL_STATUS, { timestamp: new Date().toISOString() }, (response) => {
            console.log('Response:', JSON.stringify(response, null, 2));
            resolve();
        });

        // Also listen for the response event
        socket.once(`${SOCKET_COMMANDS.TERMINAL_STATUS}:response`, (data) => {
            console.log('Response event:', JSON.stringify(data, null, 2));
        });
    });
}

async function testTerminalLogon() {
    return new Promise((resolve) => {
        console.log('\n🔐 Testing TERMINAL_LOGON...');

        socket.emit(SOCKET_COMMANDS.TERMINAL_LOGON, { timestamp: new Date().toISOString() }, (response) => {
            console.log('Response:', JSON.stringify(response, null, 2));
            resolve();
        });

        socket.once(`${SOCKET_COMMANDS.TERMINAL_LOGON}:response`, (data) => {
            console.log('Response event:', JSON.stringify(data, null, 2));
        });
    });
}

async function testNetsPayment() {
    return new Promise((resolve) => {
        console.log('\n💳 Testing NETS PAYMENT...');

        const paymentData = {
            amount: '10.00',
            currency: 'SGD',
            orderId: 'ORDER-' + Date.now(),
            paymentType: 'NETS',
            timestamp: new Date().toISOString(),
        };

        socket.emit(SOCKET_COMMANDS.TERMINAL_PAYMENT_NETS, paymentData, (response) => {
            console.log('Response:', JSON.stringify(response, null, 2));
            resolve();
        });

        socket.once(`${SOCKET_COMMANDS.TERMINAL_PAYMENT_NETS}:response`, (data) => {
            console.log('Response event:', JSON.stringify(data, null, 2));
        });
    });
}

async function testCreditCardPayment() {
    return new Promise((resolve) => {
        console.log('\n💳 Testing CREDIT CARD PAYMENT...');

        const paymentData = {
            amount: '25.50',
            currency: 'SGD',
            orderId: 'ORDER-' + Date.now(),
            paymentType: 'CREDIT_CARD',
            timestamp: new Date().toISOString(),
        };

        socket.emit(SOCKET_COMMANDS.TERMINAL_PAYMENT_CREDIT_CARD, paymentData, (response) => {
            console.log('Response:', JSON.stringify(response, null, 2));
            resolve();
        });

        socket.once(`${SOCKET_COMMANDS.TERMINAL_PAYMENT_CREDIT_CARD}:response`, (data) => {
            console.log('Response event:', JSON.stringify(data, null, 2));
        });
    });
}

async function testReceipt() {
    return new Promise((resolve) => {
        console.log('\n🖨️ Testing RECEIPT PRINTING...');

        const receiptData = {
            orderId: 'RECEIPT-' + Date.now(),
            receiptData: {
                header: 'Test Receipt',
                items: [
                    { name: 'Item 1', price: '10.00' },
                    { name: 'Item 2', price: '15.50' },
                ],
                total: '25.50',
            },
            timestamp: new Date().toISOString(),
        };

        socket.emit(SOCKET_COMMANDS.TERMINAL_RECEIPT, receiptData, (response) => {
            console.log('Response:', JSON.stringify(response, null, 2));
            resolve();
        });

        socket.once(`${SOCKET_COMMANDS.TERMINAL_RECEIPT}:response`, (data) => {
            console.log('Response event:', JSON.stringify(data, null, 2));
        });
    });
}

// Test for error handling
async function testErrorHandling() {
    return new Promise((resolve) => {
        console.log('\n⚠️ Testing ERROR HANDLING (missing required fields)...');

        // Send payment without required fields
        socket.emit(SOCKET_COMMANDS.TERMINAL_PAYMENT_NETS, {}, (response) => {
            console.log('Expected error response:', JSON.stringify(response, null, 2));
            resolve();
        });
    });
}

// Run all tests
async function runTests() {
    console.log('\n🧪 Starting Tests...');
    console.log('='.repeat(60));

    try {
        await testTerminalStatus();
        await new Promise(resolve => setTimeout(resolve, 1000));

        await testTerminalLogon();
        await new Promise(resolve => setTimeout(resolve, 1000));

        await testNetsPayment();
        await new Promise(resolve => setTimeout(resolve, 1000));

        await testCreditCardPayment();
        await new Promise(resolve => setTimeout(resolve, 1000));

        await testReceipt();
        await new Promise(resolve => setTimeout(resolve, 1000));

        await testErrorHandling();

        console.log('\n='.repeat(60));
        console.log('✅ All tests completed!');
        console.log('='.repeat(60));

        // Keep connection alive to listen for events
        console.log('\n👂 Listening for events... (Press Ctrl+C to exit)');
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Closing connection...');
    socket.disconnect();
    process.exit(0);
});
