const axios = require('axios');

const BASE_URL = 'http://localhost:5201';

async function testPrint() {
    console.log('\nTesting POST /api/print-json with Structured Data...');
    const payload = {
        "receipts": [
            {
                "receiptId": "RCPT-1001",
                "date": "2026-01-10",
                "customer": {
                    "name": "Arun Kumar",
                    "email": "arun@example.com",
                    "phone": "+91-9876543210"
                },
                "items": [
                    {
                        "name": "Service Booking",
                        "quantity": 1,
                        "unitPrice": 1500,
                        "total": 1500
                    },
                    {
                        "name": "Extra Accessories",
                        "quantity": 2,
                        "unitPrice": 250,
                        "total": 500
                    }
                ],
                "summary": {
                    "subTotal": 2000,
                    "tax": 360,
                    "discount": 0,
                    "grandTotal": 2360
                },
                "payment": {
                    "method": "UPI",
                    "status": "PAID",
                    "transactionId": "UPI783462"
                }
            },
            {
                "receiptId": "RCPT-1002",
                "date": "2026-01-11",
                "customer": {
                    "name": "Priya Sharma",
                    "email": "priya@example.com",
                    "phone": "+91-9123456789"
                },
                "items": [
                    {
                        "name": "Product Purchase",
                        "quantity": 3,
                        "unitPrice": 800,
                        "total": 2400
                    }
                ],
                "summary": {
                    "subTotal": 2400,
                    "tax": 432,
                    "discount": 200,
                    "grandTotal": 2632
                },
                "payment": {
                    "method": "Credit Card",
                    "status": "PAID",
                    "transactionId": "CC998877"
                }
            }
        ]
    };

    try {
        const res = await axios.post(`${BASE_URL}/api/print-json`, payload);
        console.log('Response Status:', res.status);
        console.log('Response Data:', res.data);
        return true;
    } catch (e) {
        console.error('Print Failed:', e.message);
        if (e.response) console.error('Data:', e.response.data);
        return false;
    }
}

(async () => {
    console.log('Waiting for server startup...');
    await new Promise(r => setTimeout(r, 2000));
    await testPrint();
})();
