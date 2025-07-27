// server.js
const http = require('http');
const { PeerServer } = require('peer');

// Koyeb 会通过环境变量 PORT 注入它期望服务监听的端口
const PORT = process.env.PORT || 9000;

// 1. 创建一个标准的HTTP服务器
const server = http.createServer((req, res) => {
  // 这是为了让 Koyeb 的健康检查或外部监控服务能够访问，从而保持服务实例活跃
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>服务器正在运行</h1><p>ARKSEC.NET</p>');
  } else {
    // 对于所有其他HTTP请求，返回404
    res.writeHead(404);
    res.end();
  }
});

// 2. 创建 PeerServer 实例，并将其附加到已有的HTTP服务器上
const peerServer = PeerServer({
  server: server, // 关键：将 peer a附加到现有服务器
  path: '/',      // 将 PeerJS 服务部署在根路径下，简化客户端配置
});

console.log('PeerJS 服务器正在准备启动...');

peerServer.on('connection', (client) => {
  console.log(`客户端已连接: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`客户端已断开: ${client.getId()}`);
});

// 3. 启动HTTP服务器
server.listen(PORT, () => {
  console.log(`服务器已启动，正在监听端口: ${PORT}`);
});
