// server.js (已集成房间号功能)
const http = require('http');
const express = require('express');
const cors = require('cors'); // 引入 cors 中间件
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 8080;

// --- 房间号映射存储 ---
// shortCode -> longId
const roomMappings = {};
// longId -> shortCode (用于快速清理)
const longIdMappings = {};

// --- 短码生成算法 (与客户端保持一致) ---
function peerIdToShortCode(peerId) {
    if (!peerId) return null;
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) {
        const char = peerId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // 转换为32位整数
    }
    return (Math.abs(hash) % 900000 + 100000).toString();
}

// 1. 创建 Express 应用
const app = express();

// --- 中间件设置 ---
app.use(cors()); // 启用 CORS，允许跨域请求
app.use(express.json()); // 启用 JSON 解析，用于处理 POST 请求体

// 2. 添加“保活”路由
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<h1>PeerJS信令与房间号服务器正在运行</h1>');
});

// --- 新增API: 注册房间并获取短码 ---
app.post('/register-room', (req, res) => {
    const { longId } = req.body;
    if (!longId) {
        return res.status(400).json({ error: '缺少 longId' });
    }

    const shortCode = peerIdToShortCode(longId);
    roomMappings[shortCode] = longId;
    longIdMappings[longId] = shortCode;

    console.log(`房间已注册: ${shortCode} -> ${longId}`);
    res.json({ shortCode });
});

// --- 新增API: 通过短码查询完整ID ---
app.get('/get-room/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const longId = roomMappings[shortCode];

    if (longId) {
        console.log(`房间查询成功: ${shortCode} -> ${longId}`);
        res.json({ longId });
    } else {
        console.log(`房间查询失败: 未找到 ${shortCode}`);
        res.status(404).json({ error: '未找到该房间号' });
    }
});


// 3. 创建 HTTP 服务器
const server = http.createServer(app);

// 4. 创建 PeerServer
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/',
  allow_origin: '*',
});

// 5. 挂载 PeerServer 中间件
app.use('/peerjs', peerServer);

// --- PeerServer 事件监听 ---
peerServer.on('connection', (client) => {
  console.log(`客户端已连接: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  const longId = client.getId();
  const shortCode = longIdMappings[longId];

  if (shortCode) {
      delete roomMappings[shortCode];
      delete longIdMappings[longId];
      console.log(`客户端已断开并清理房间映射: ${shortCode} -> ${longId}`);
  } else {
      console.log(`客户端已断开: ${longId} (无房间映射)`);
  }
});

// 6. 启动服务器
server.listen(PORT, () => {
  console.log(`HTTP 和 PeerJS 服务器已启动，正在监听端口: ${PORT}`);
});

