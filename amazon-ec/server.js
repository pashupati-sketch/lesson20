'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DATABASE_PATH = process.env.SHOP_DB_PATH || path.join(__dirname, 'ec.db');
const STATIC_DIRECTORY = path.join(__dirname, 'static');
const MAX_BODY_BYTES = 1024 * 1024;
const PAYMENT_METHODS = new Set(['credit', 'bank', 'cod']);
const CONTENT_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

const db = new Database(DATABASE_PATH);
db.pragma('foreign_keys = ON');
db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

function sendJson(response, statusCode, value) {
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;

        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            size += Buffer.byteLength(chunk);
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
                return;
            }
            body += chunk;
        });
        request.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
            }
        });
        request.on('error', reject);
    });
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/products') {
        const products = db.prepare('SELECT id, name, price FROM products ORDER BY id').all();
        sendJson(response, 200, products);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/product') {
        const id = positiveInteger(url.searchParams.get('id'));
        if (id === null) {
            sendJson(response, 400, { error: 'A valid product id is required.' });
            return;
        }

        const product = db.prepare('SELECT id, name, price FROM products WHERE id = ?').get(id);
        if (!product) {
            sendJson(response, 404, { error: 'Product not found.' });
            return;
        }

        sendJson(response, 200, product);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/orders') {
        const orders = db.prepare(`
            SELECT products.name AS product_name, products.price, orders.quantity
            FROM orders
            JOIN products ON products.id = orders.product_id
            ORDER BY orders.id DESC
        `).all();
        sendJson(response, 200, orders);
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/orders') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(response, 400, { error: 'Request body must be a JSON object.' });
            return;
        }
        const productId = positiveInteger(body.product_id);
        const quantity = positiveInteger(body.quantity);
        if (productId === null || quantity === null) {
            sendJson(response, 400, { error: 'A valid product_id and quantity are required.' });
            return;
        }

        const productExists = db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId);
        if (!productExists) {
            sendJson(response, 404, { error: 'Product not found.' });
            return;
        }

        const result = db.prepare(
            'INSERT INTO orders (product_id, quantity) VALUES (?, ?)',
        ).run(productId, quantity);
        sendJson(response, 201, { id: Number(result.lastInsertRowid), message: '注文しました' });
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/payments') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(response, 400, { error: 'Request body must be a JSON object.' });
            return;
        }
        const orderId = positiveInteger(body.order_id);
        const amount = positiveInteger(body.amount);
        const method = typeof body.method === 'string' ? body.method : '';
        if (orderId === null || amount === null || !PAYMENT_METHODS.has(method)) {
            sendJson(response, 400, { error: 'A valid order_id, amount, and payment method are required.' });
            return;
        }

        const orderExists = db.prepare('SELECT 1 FROM orders WHERE id = ?').get(orderId);
        if (!orderExists) {
            sendJson(response, 404, { error: 'Order not found.' });
            return;
        }

        const result = db.prepare(`
            INSERT INTO payments (order_id, amount, method, status)
            VALUES (?, ?, ?, 'completed')
        `).run(orderId, amount, method);
        const payment = db.prepare(`
            SELECT id, order_id, amount, method, status, created_at
            FROM payments WHERE id = ?
        `).get(Number(result.lastInsertRowid));
        sendJson(response, 201, payment);
        return;
    }

    sendJson(response, 404, { error: 'API route not found.' });
}

function serveStatic(request, response, pathname) {
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/static(?=\/|$)/, '');
    let filePath;
    try {
        filePath = path.resolve(STATIC_DIRECTORY, `.${decodeURIComponent(relativePath)}`);
    } catch {
        sendJson(response, 400, { error: 'Invalid file path.' });
        return;
    }

    if (!filePath.startsWith(`${STATIC_DIRECTORY}${path.sep}`)) {
        sendJson(response, 403, { error: 'Forbidden.' });
        return;
    }

    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            sendJson(response, 404, { error: 'File not found.' });
            return;
        }

        response.writeHead(200, {
            'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        });
        if (request.method === 'HEAD') {
            response.end();
            return;
        }
        fs.createReadStream(filePath).pipe(response);
    });
}

const server = http.createServer((request, response) => {
    let url;
    try {
        url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    } catch {
        sendJson(response, 400, { error: 'Invalid request URL.' });
        return;
    }

    if (url.pathname.startsWith('/api/')) {
        handleApi(request, response, url).catch((error) => {
            console.error('API request failed:', error);
            if (!response.headersSent) {
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'Internal server error.',
                });
            }
        });
        return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
    }

    serveStatic(request, response, url.pathname);
});

server.listen(PORT, () => {
    console.log(`Amazon EC server listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close(() => {
            db.close();
            process.exit(0);
        });
    });
}
