// server.js (最终修复版)
const http = require('http');
const express = require('express');
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 8080;

// 1. 创建 Express 应用
const app = express();

// 2. 添加“保活”路由，用于响应 Koyeb 的健康检查
app.get('/', (req, res, next) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<h1>PeerJS信令服务器正在运行</h1>');
});

// 3. 创建一个标准的 HTTP 服务器，并将 Express 应用作为请求处理器
const server = http.createServer(app);

// 4. ✅ 修复: 创建 PeerServer 并明确配置
const peerServer = ExpressPeerServer(server, {
  debug: true,      // 开启debug模式，方便在Koyeb日志中查看问题
  path: '/',        // 将PeerJS服务部署在根路径下
  allow_origin: '*',// 解决跨域问题
});

// 5. ✅ 修复: 将 PeerServer 作为中间件挂载到指定的路径上
// 客户端将连接到 wss://your-url.com/peerjs
app.use('/peerjs', peerServer);

// 监听 PeerServer 的事件，用于观察连接状态
peerServer.on('connection', (client) => {
  console.log(`客户端已连接: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`客户端已断开: ${client.getId()}`);
});

// 6. 启动服务器
server.listen(PORT, () => {
  console.log(`HTTP 和 PeerJS 服务器已启动，正在监听端口: ${PORT}`);
});
