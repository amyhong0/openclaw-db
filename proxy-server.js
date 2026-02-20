const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = parseInt(process.env.AMY_DASHBOARD_PORT || '8080', 10);
const GW_WS = 'ws://localhost:18789';
const STATIC_DIR = __dirname;

const server = http.createServer((req, res) => {
  let filePath = path.join(STATIC_DIR, req.url.split('?')[0]);
  if (filePath.endsWith('/')) filePath = path.join(filePath, 'amy-dashboard.html');

  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (clientWs) => {
  const gwWs = new WebSocket(GW_WS, { origin: 'http://localhost:18789' });
  const clientQueue = [];

  clientWs.on('message', (data) => {
    const msg = data.toString();
    if (gwWs.readyState === WebSocket.OPEN) {
      gwWs.send(msg);
    } else {
      clientQueue.push(msg);
    }
  });

  gwWs.on('open', () => {
    clientQueue.forEach(msg => gwWs.send(msg));
    clientQueue.length = 0;
  });

  gwWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data.toString());
    }
  });

  gwWs.on('close', (code, reason) => {
    if (clientWs.readyState <= WebSocket.OPEN) clientWs.close(code, reason.toString());
  });

  clientWs.on('close', () => {
    if (gwWs.readyState <= WebSocket.OPEN) gwWs.close();
  });

  gwWs.on('error', (e) => { console.error('gw error:', e.message); if (clientWs.readyState <= WebSocket.OPEN) clientWs.close(); });
  clientWs.on('error', (e) => { console.error('client error:', e.message); if (gwWs.readyState <= WebSocket.OPEN) gwWs.close(); });
});

server.listen(PORT, () => console.log(`AMY proxy on http://localhost:${PORT}`));
