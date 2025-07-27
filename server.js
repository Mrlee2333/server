// server.js
const http = require('http');
const { PeerServer } = require('peer');

const PORT = process.env.PORT || 9000;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>PeerJS信令服务器正在运行</h1>');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const peerServer = PeerServer({
  path: '/',
  noServer: true
});


server.on('upgrade', (request, socket, head) => {
  peerServer.handleUpgrade(request, socket, head);
});

console.log('PeerJS 服务器正在准备...');

peerServer.on('connection', (client) => {
  console.log(`客户端已连接: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`客户端已断开: ${client.getId()}`);
});


server.listen(PORT, () => {
  console.log(`HTTP 和 PeerJS 服务器已启动，正在监听端口: ${PORT}`);
});