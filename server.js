// server.js (最终增强版)
const http = require('http');
const express = require('express');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');

const PORT = process.env.PORT || 8080;

// [增强-房间管理] 使用更健壮的房间状态对象
// rooms = { '123456': { host: 'p1_longId', clients: ['p1_longId', 'p2_longId'] } }
const rooms = {};

function generateShortCode() {
    return (Math.floor(Math.random() * 900000) + 100000).toString();
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<h1>PeerJS信令与增强功能服务器正在运行</h1>');
});

// [新增-时钟同步] API: 获取高精度服务器时间
const serverStartTime = process.hrtime.bigint();
app.get('/get-time', (req, res) => {
    const uptimeNanoseconds = process.hrtime.bigint() - serverStartTime;
    const serverTimeMilliseconds = Number(uptimeNanoseconds) / 1e6;
    res.json({ serverTime: serverTimeMilliseconds });
});

// [增强-房间管理] API: 注册房间并获取短码
app.post('/register-room', (req, res) => {
    const { longId } = req.body;
    if (!longId) {
        return res.status(400).json({ error: '缺少 longId' });
    }
    
    // 确保生成的 shortCode 是唯一的
    let shortCode;
    do {
        shortCode = generateShortCode();
    } while (rooms[shortCode]);

    rooms[shortCode] = {
        host: longId,
        clients: [longId]
    };

    console.log(`[Room] 房间已创建: ${shortCode} -> Host: ${longId}`);
    res.json({ shortCode });
});

// [增强-房间管理] API: P1上报P2已连接
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


// [增强-房间管理] API: 通过短码查询房主ID
app.get('/get-room/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const room = rooms[shortCode];

    if (room) {
        console.log(`[Room] 房间查询成功: ${shortCode} -> Host: ${room.host}`);
        res.json({ longId: room.host });
    } else {
        console.log(`[Room] 房间查询失败: 未找到 ${shortCode}`);
        res.status(404).json({ error: '未找到该房间号' });
    }
});

const server = http.createServer(app);

const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/',
  allow_origin: '*',
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log(`[Peer] 客户端已连接: ${client.getId()}`);
});

// [增强-断线处理]
peerServer.on('disconnect', (client) => {
  const disconnectedId = client.getId();
  console.log(`[Peer] 客户端已断开: ${disconnectedId}`);
  
  // 遍历所有房间，查找并移除断开连接的客户端
  for (const shortCode in rooms) {
      const room = rooms[shortCode];
      if (room.clients.includes(disconnectedId)) {
          
          // 如果房主断开，直接删除整个房间
          if (room.host === disconnectedId) {
              console.log(`[Room] 房主 ${disconnectedId} 已断开，房间 ${shortCode} 已清理。`);
              delete rooms[shortCode];
          } else {
              // 如果是P2断开，则将其从客户端列表中移除
              room.clients = room.clients.filter(id => id !== disconnectedId);
              console.log(`[Room] 玩家 ${disconnectedId} 已离开房间 ${shortCode}。`);
          }
          // 找到了就跳出循环
          break;
      }
  }
});

server.listen(PORT, () => {
  console.log(`HTTP 和 PeerJS 服务器已启动，正在监听端口: ${PORT}`);
});
