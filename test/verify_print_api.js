const axios = require('axios');

const BASE_URL = 'http://localhost:5201';

async function testListPrinters() {
    console.log('Testing GET /api/printers...');
    try {
        const res = await axios.get(`${BASE_URL}/api/printers`);
        console.log('Response Status:', res.status);
        console.log('Printers found:', res.data.printers.length);
        console.log('Printer names:', res.data.printers.map(p => p.Name));
        return true;
    } catch (e) {
        console.error('List Printers Failed:', e.message);
        if (e.response) console.error('Data:', e.response.data);
        return false;
    }
}

async function testPrint() {
    console.log('\nTesting POST /api/print-json...');
    const payload = {
        content: "{c:API Integration Test}\n{c:Passed}\n^^\n"
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

    const listSuccess = await testListPrinters();
    if (listSuccess) {
        await testPrint();
    }
})();
