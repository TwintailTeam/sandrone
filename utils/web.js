const http = require('node:http');

const routes = new Map();
const HEADERS = { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const route = (path, handler, method = 'GET') => routes.set(`${method} ${path}`, handler);

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024) { reject(new Error('request body too large')); return req.destroy(); }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function start() {
    route('/', (req, res) => res.writeHead(200, HEADERS).end('ok'));
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const handler = routes.get(`${req.method} ${url.pathname}`);
            if (!handler) { return res.writeHead(404, HEADERS).end('Not found'); }
            req.query = url.searchParams;
            req.body = () => readBody(req);
            req.cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')).filter(([name, value]) => name && value));
            await handler(req, res);
        } catch (error) {
            console.error(`[web] ${req.url?.split('?')[0]} failed:`, error);
            if (!res.headersSent) { res.writeHead(500, HEADERS).end('Something went wrong.'); }
        }
    });
    server.on('error', (error) => console.error('[web] server error:', error));
    server.listen(Number(process.env.WEB_PORT) || 3000, () => console.log(`Web server listening on port ${server.address().port}`));
}

module.exports = { HEADERS, route, start, escapeHtml };
