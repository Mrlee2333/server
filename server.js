const http = require('http');
const express = require('express');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');
const { v4: uuidv4 } = require('uuid');

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

// 【恢复】API: 获取高精度服务器时间 (uptime)
const serverStartTime = process.hrtime.bigint();
app.get('/get-time', (req, res) => {
    const uptimeNanoseconds = process.hrtime.bigint() - serverStartTime;
    const serverTimeMilliseconds = Number(uptimeNanoseconds) / 1e6;
    res.json({ serverTime: serverTimeMilliseconds });
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
        createdAt: Date.now()
    };

    console.log(`[API] 房间已创建: ${shortCode} -> Host: ${longId}`);
    res.status(201).json({ shortCode });
});

// 【恢复】API: P1上报P2已连接
app.post('/register-player2', (req, res) => {
    const { shortCode, p2_longId } = req.body;
    if (!shortCode || !p2_longId) {
        return res.status(400).json({ error: '缺少 shortCode 或 p2_longId' });
    }

    const room = rooms[shortCode];
    if (room && room.clients.length < 2 && !room.clients.includes(p2_longId)) {
        room.clients.push(p2_longId);
        console.log(`[Room] P2已加入房间 ${shortCode}: ${p2_longId}`);
        res.status(200).send();
    } else if (room) {
         res.status(409).json({ error: '房间已满或玩家已在房间内' }); // 409 Conflict
    } else {
        res.status(404).json({ error: '未找到房间' });
    }
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
  proxied: true,
  generateClientId: uuidv4,
});

app.use('/peerjs', peerServer);

// --- PeerServer 事件监听 ---
peerServer.on('connection', (client) => {
  console.log(`[PeerJS] 客户端已连接: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  const disconnectedId = client.getId();
  if (!disconnectedId) return;

  console.log(`[PeerJS] 客户端已断开: ${disconnectedId}`);
  
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

// 定期清理过期的空房间
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
