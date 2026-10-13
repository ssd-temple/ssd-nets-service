# Socket.IO Command Reference

Quick reference for integrating with NPService-kiosk Socket.IO commands.

## Connection

```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:5201');

socket.on('connect', () => {
    socket.emit('ADD_CLIENT_SERVICE', {});
});
```

## Available Commands

### 1. Terminal Status Check

**Event:** `terminal:status`

**Payload:**
```javascript
{
  timestamp: ISO string  // Optional
}
```

**Example:**
```javascript
socket.emit('terminal:status', 
  { timestamp: new Date().toISOString() },
  (response) => console.log(response)
);
```

**Response:**
```javascript
{
  status: "success",
  message: "Terminal status check initiated",
  timestamp: "2026-01-26T..."
}
```

---

### 2. Terminal Logon

**Event:** `terminal:logon`

**Payload:**
```javascript
{
  timestamp: ISO string  // Optional
}
```

**Example:**
```javascript
socket.emit('terminal:logon',
  { timestamp: new Date().toISOString() },
  (response) => console.log(response)
);
```

**Response:**
```javascript
{
  status: "success",
  message: "Terminal logon initiated",
  timestamp: "2026-01-26T..."
}
```

---

### 3. NETS Payment

**Event:** `terminal:payment:nets`

**Payload:**
```javascript
{
  amount: string,      // Required - e.g., "10.00"
  currency: string,    // Required - e.g., "SGD"
  orderId: string,     // Optional
  paymentType: string, // Optional
  timestamp: ISO string // Optional
}
```

**Example:**
```javascript
socket.emit('terminal:payment:nets',
  {
    amount: '10.00',
    currency: 'SGD',
    orderId: 'ORDER-123',
    timestamp: new Date().toISOString()
  },
  (response) => console.log(response)
);
```

**Response:**
```javascript
{
  status: "success",
  message: "NETS payment initiated",
  orderId: "ORDER-123",
  amount: "10.00",
  timestamp: "2026-01-26T..."
}
```

---

### 4. Credit Card Payment

**Event:** `terminal:payment:credit_card`

**Payload:**
```javascript
{
  amount: string,      // Required - e.g., "25.50"
  currency: string,    // Required - e.g., "SGD"
  orderId: string,     // Optional
  paymentType: string, // Optional
  timestamp: ISO string // Optional
}
```

**Example:**
```javascript
socket.emit('terminal:payment:credit_card',
  {
    amount: '25.50',
    currency: 'SGD',
    orderId: 'ORDER-456',
    timestamp: new Date().toISOString()
  },
  (response) => console.log(response)
);
```

**Response:**
```javascript
{
  status: "success",
  message: "Credit card payment initiated",
  orderId: "ORDER-456",
  amount: "25.50",
  timestamp: "2026-01-26T..."
}
```

---

### 5. Print Receipt

**Event:** `terminal:receipt`

**Payload:**
```javascript
{
  orderId: string,     // Required
  receiptData: object, // Required - JSON receipt data
  printerName: string  // Optional - uses configured printer if not provided
}
```

**Example:**
```javascript
socket.emit('terminal:receipt',
  {
    orderId: 'RECEIPT-789',
    receiptData: {
      header: 'Store Receipt',
      items: [
        { name: 'Item 1', price: '10.00' },
        { name: 'Item 2', price: '15.50' }
      ],
      total: '25.50'
    }
  },
  (response) => console.log(response)
);
```

**Response:**
```javascript
{
  status: "success",
  message: "Receipt printing initiated",
  orderId: "RECEIPT-789",
  timestamp: "2026-01-26T..."
}
```

---

## Event Listeners

### Command Response Events

Each command emits a corresponding response event:

```javascript
socket.on('terminal:status:response', (data) => {});
socket.on('terminal:logon:response', (data) => {});
socket.on('terminal:payment:nets:response', (data) => {});
socket.on('terminal:payment:credit_card:response', (data) => {});
socket.on('terminal:receipt:response', (data) => {});
```

### Real-time Status Events

```javascript
// Terminal events
socket.on('terminal:status', (data) => {});
socket.on('terminal:logon', (data) => {});
socket.on('terminal:payment', (data) => {});

// SDK events
socket.on('STATUS_MESSAGE', (data) => {
  // data.status: 'INITIATED', 'SUCCESS', 'FAILED'
});

socket.on('LOGON_MESSAGE', (data) => {
  // data.status: 'INITIATED', 'SUCCESS', 'FAILED'
});

socket.on('PAYMENT_MESSAGE', (data) => {
  // data.status: 'INITIATED', 'SUCCESS', 'RETRY', 'CANCELLED', 'TERMINAL_ERROR', 'APPROVED_FLAGGED'
});

// Print events
socket.on('print:started', (data) => {});
socket.on('print:completed', (data) => {});
socket.on('print:failed', (data) => {});
```

---

## Error Handling

All commands return standardized error responses:

```javascript
{
  status: "error",
  error: "Error message description",
  timestamp: "2026-01-26T..."
}
```

**Common Errors:**

- Missing required fields: `"Missing required fields: amount, currency"`
- Handler not registered: `"Terminal [operation] handler not registered"`
- Print errors: `"Print job failed: [reason]"`

---

## Testing

Run the test client:

```bash
SERVER_URL=http://localhost:5201 node test-socket-client.js
```

Or modify the server URL in the test file directly.

---

## Response Patterns

### Using Callbacks

```javascript
socket.emit('terminal:status', data, (response) => {
  if (response.status === 'success') {
    console.log('✅ Success:', response.message);
  } else {
    console.error('❌ Error:', response.error);
  }
});
```

### Using Events

```javascript
// Emit command
socket.emit('terminal:status', data);

// Listen for response event
socket.once('terminal:status:response', (response) => {
  if (response.status === 'success') {
    console.log('✅ Success:', response.message);
  } else {
    console.error('❌ Error:', response.error);
  }
});
```

### Listening to Real-time Updates

```javascript
// Listen for all payment status updates
socket.on('PAYMENT_MESSAGE', (data) => {
  switch(data.status) {
    case 'INITIATED':
      console.log('Payment started...');
      break;
    case 'SUCCESS':
      console.log('Payment approved:', data.response.translated);
      break;
    case 'CANCELLED':
      console.log('Payment cancelled');
      break;
    case 'RETRY':
      console.log('Payment timeout, retry...');
      break;
    case 'TERMINAL_ERROR':
      console.error('Terminal error');
      break;
  }
});
```

---

## Complete Example

```javascript
const io = require('socket.io-client');

// Connect
const socket = io('http://localhost:5201', {
  transports: ['websocket'],
  reconnection: true,
});

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  socket.emit('ADD_CLIENT_SERVICE', {});
});

socket.on('room:joined', (data) => {
  console.log('Joined room:', data.room);
  
  // Now you can send commands
  processPayment();
});

// Listen to payment updates
socket.on('PAYMENT_MESSAGE', (data) => {
  console.log('Payment status:', data);
});

function processPayment() {
  socket.emit('terminal:payment:nets',
    {
      amount: '10.00',
      currency: 'SGD',
      orderId: 'ORDER-' + Date.now(),
    },
    (response) => {
      if (response.status === 'success') {
        console.log('Payment initiated successfully');
      } else {
        console.error('Payment failed:', response.error);
      }
    }
  );
}

socket.on('disconnect', () => {
  console.log('Disconnected');
});
```

---

## Environment Variables

- **PORT:** Server runs on port 5201 (configured in `.env`)
- **SERVER_URL:** For test client, default `http://localhost:5200` (update to 5201)

---

## Notes

- All timestamps use ISO 8601 format
- Response events are emitted in addition to callbacks
- Commands are validated before processing
- Failed operations return detailed error messages
- Existing HTTP endpoints remain functional
