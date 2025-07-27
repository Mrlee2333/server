// server.js (最终修复版)
const http = require('http');
const express = require('express');
const { PeerServer } = require('peer');

const PORT = process.env.PORT || 9000;

// 1. 创建 Express 应用
const app = express();

// 2. 创建一个标准的 HTTP 服务器，并将 Express 应用作为请求处理器
const server = http.createServer(app);

// 3. ✅ 修复: 将 PeerServer 作为 Express 的中间件使用
// 这样 PeerServer 就可以正确处理所有相关的HTTP请求（包括CORS预检）和WebSocket请求
const peerServer = PeerServer(server, {
  path: '/peerjs', // 使用一个明确的路径，例如 /peerjs
});

// 4. 将 PeerServer 中间件挂载到 Express 应用上
app.use(peerServer);

// 5. 设置“保活”路由，用于响应 Koyeb 的健康检查
app.get('/', (req, res) => {
  res.send('<h1>PeerJS Signaling Server is alive and running correctly.</h1>');
});

// 监听 PeerServer 的事件，用于在日志中观察连接状态
peerServer.on('connection', (client) => {
  console.log(`Client connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`Client disconnected: ${client.getId()}`);
});

// 6. 启动服务器
server.listen(PORT, () => {
  console.log(`Server is running and listening on port ${PORT}`);
});
