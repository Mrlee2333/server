const http = require('http');
const express = require('express');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');
const { v4: uuidv4 } = require('uuid'); // 推荐使用 uuid 来确保ID的唯一性

const PORT = process.env.PORT || 8080;

const rooms = {};
const ROOM_EXPIRATION_MS = 2 * 60 * 60 * 1000; // 房间2小时后过期

function generateShortCode() {
    return (Math.floor(Math.random() * 900000) + 100000).toString();
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<h1>PeerJS 信令与增强功能服务器正在运行</h1>');
});

// API: 注册房间并获取短码
app.post('/register-room', (req, res) => {
    const { longId } = req.body;
    if (!longId) {
        return res.status(400).json({ error: '缺少 longId' });
    }
    
    let shortCode;
    do {
        shortCode = generateShortCode();
    } while (rooms[shortCode]);

    rooms[shortCode] = {
        host: longId,
        clients: [longId],
        createdAt: Date.now() // 记录创建时间
    };

    console.log(`[API] 房间已创建: ${shortCode} -> Host: ${longId}`);
    res.status(201).json({ shortCode });
});

// API: 通过短码查询房主ID
app.get('/get-room/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const room = rooms[shortCode];

    if (room) {
        console.log(`[API] 房间查询成功: ${shortCode} -> Host: ${room.host}`);
        res.json({ longId: room.host });
    } else {
        console.log(`[API] 房间查询失败: 未找到 ${shortCode}`);
        res.status(404).json({ error: '未找到该房间号或已过期' });
    }
});

const server = http.createServer(app);

// PeerServer 配置
const peerServer = ExpressPeerServer(server, {
  debug: true,
  // 【关键修复】明确告知 PeerServer 它在反向代理后面运行 (例如在Koyeb, Heroku, Nginx后)
  proxied: true,
  generateClientId: uuidv4, // 使用 uuid 生成客户端ID，更可靠
});

// 将 PeerServer 挂载到 /peerjs 路径
app.use('/peerjs', peerServer);

// --- PeerServer 事件监听 ---
peerServer.on('connection', (client) => {
  console.log(`[PeerJS] 客户端已连接: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  const disconnectedId = client.getId();
  if (!disconnectedId) return; // 有时ID可能为空，增加保护

  console.log(`[PeerJS] 客户端已断开: ${disconnectedId}`);
  
  // 遍历所有房间，查找并移除断开连接的客户端
  for (const shortCode in rooms) {
      const room = rooms[shortCode];
      if (room.clients.includes(disconnectedId)) {
          
          if (room.host === disconnectedId) {
              console.log(`[Room] 房主 ${disconnectedId} 已断开，房间 ${shortCode} 已清理。`);
              delete rooms[shortCode];
          } else {
              room.clients = room.clients.filter(id => id !== disconnectedId);
              console.log(`[Room] 玩家 ${disconnectedId} 已离开房间 ${shortCode}。`);
          }
          break;
      }
  }
});

// 【增强】定期清理过期的空房间，防止内存泄漏
setInterval(() => {
    const now = Date.now();
    for (const shortCode in rooms) {
        if (now - rooms[shortCode].createdAt > ROOM_EXPIRATION_MS) {
            console.log(`[Cleanup] 清理过期房间: ${shortCode}`);
            delete rooms[shortCode];
        }
    }
}, 60 * 60 * 1000); // 每小时检查一次

server.listen(PORT, () => {
  console.log(`HTTP 和 PeerJS 服务器已启动，正在监听端口: ${PORT}`);
});
