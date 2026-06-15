const http = require('http');
const express = require('express');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io'); 
const xss = require('xss');             

// ==========================================
// 环境变量与全局安全配置
// ==========================================
const PORT = process.env.PORT || 8080;
const AUTH_KEY = process.env.AUTH_KEY || 'YOUR_SECRET_KEY'; 

// 安全阈值配置
const ROOM_EMPTY_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟无人在内自动销毁
const ROOM_HARD_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 绝对存活上限 24 小时
const MAX_GLOBAL_ROOMS = 5000; // 全局最大房间数，防止内存耗尽
const MAX_PAYLOAD_SIZE = 1e5; // Socket.io 单帧最大 100KB，防大数据包攻击

const rooms = {};

// ==========================================
// 防恶意攻击：IP 频率限制中间件 (轻量级内存版)
// ==========================================
const ipCreationCounts = new Map();
function rateLimitMiddleware(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const now = Date.now();
    
    let userRecords = ipCreationCounts.get(ip) || [];
    // 清理 1 小时前的记录
    userRecords = userRecords.filter(timestamp => now - timestamp < 60 * 60 * 1000);
    
    if (userRecords.length >= 30) {
        return res.status(429).json({ error: '创建房间过于频繁，请稍后再试' });
    }
    
    userRecords.push(now);
    ipCreationCounts.set(ip, userRecords);
    next();
}

// 自动清理 IP 记录池，防止 Map 无限膨胀
setInterval(() => ipCreationCounts.clear(), 2 * 60 * 60 * 1000);

function generateShortCode() {
    return (Math.floor(Math.random() * 900000) + 100000).toString();
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
// 安全升级：限制 HTTP POST Body 最大 50kb
app.use(express.json({ limit: '50kb' })); 

// ==========================================
// 1. 基础 HTTP 路由
// ==========================================
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h1>Nexus Backend is running (PeerJS + Socket.io Secure)</h1>');
});

const serverStartTime = process.hrtime.bigint();
app.get('/get-time', (req, res) => {
    const uptimeNanoseconds = process.hrtime.bigint() - serverStartTime;
    res.json({ serverTime: Number(uptimeNanoseconds) / 1e6 });
});

// 应用频率限制
app.post('/register-room', rateLimitMiddleware, (req, res) => {
    if (Object.keys(rooms).length >= MAX_GLOBAL_ROOMS) {
        return res.status(503).json({ error: '服务器房间容量已满，请稍后再试' });
    }

    const { longId } = req.body;
    if (!longId) return res.status(400).json({ error: '缺少 longId' });
    
    let shortCode;
    do { shortCode = generateShortCode(); } while (rooms[shortCode]);

    rooms[shortCode] = { 
        host: longId, 
        clients: [longId], 
        createdAt: Date.now(),
        emptySince: null // 用于记录房间开始变空的时间戳
    };
    console.log(`[API] 房间已创建: ${shortCode} -> Host: ${longId}`);
    res.status(201).json({ shortCode });
});

app.post('/register-player2', (req, res) => {
    const { shortCode, p2_longId } = req.body;
    if (!shortCode || !p2_longId) return res.status(400).json({ error: '缺少参数' });

    const room = rooms[shortCode];
    if (room && room.clients.length < 2 && !room.clients.includes(p2_longId)) {
        room.clients.push(p2_longId);
        room.emptySince = null; // 只要有人加入，立刻打断空闲倒计时
        console.log(`[Room] P2已加入房间 ${shortCode}: ${p2_longId}`);
        res.status(200).send();
    } else if (room) {
         res.status(409).json({ error: '房间已满或玩家已在内' }); 
    } else {
        res.status(404).json({ error: '未找到房间' });
    }
});

app.get('/get-room/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const room = rooms[shortCode];
    if (room) res.json({ longId: room.host });
    else res.status(404).json({ error: '未找到该房间或已过期' });
});

const server = http.createServer(app);

// ==========================================
// 2. Socket.io 实时服务 (状态同步/聊天/游戏)
// ==========================================
const io = new Server(server, {
    cors: {
        origin: [
    "https://player.arksec.net",
    "https://play.arksec.net",
    "https://game.arksec.net"
    ],
        methods: ["GET", "POST"]
    },
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    // 安全升级：限制单次 WebSocket 通信最大体积 (100KB)，防恶意发包
    maxHttpBufferSize: MAX_PAYLOAD_SIZE 
});

io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
    if (token === `Bearer ${AUTH_KEY}` || token === AUTH_KEY) return next();
    
    console.log(`[Socket] 拒绝未授权连接: ${socket.id}`);
    return next(new Error('Unauthorized: Invalid Server Key'));
});

io.on('connection', (socket) => {
    socket.on('join_room', (shortCode) => {
        if (!shortCode || typeof shortCode !== 'string') return;
        socket.join(shortCode);
        // 用户加入 socket 房间，重置空闲计时
        if (rooms[shortCode]) rooms[shortCode].emptySince = null;
    });

    // 1. 聊天频道 (带 XSS 防护)
    socket.on('chat_message', (data) => {
        const { shortCode, message, senderId } = data;
        if (!shortCode || !message) return;
        const safeMessage = xss(message.trim());
        if (safeMessage) {
            io.to(shortCode).emit('chat_message', {
                senderId: xss(senderId),
                message: safeMessage,
                timestamp: Date.now()
            });
        }
    });

    // 2. 视频流同步频道
    socket.on('media_sync', (data) => {
        const { shortCode, type, action, currentTime, mediaUrl } = data;
        if (!shortCode) return;
        socket.to(shortCode).emit('media_sync', {
            type, action, currentTime,
            mediaUrl: mediaUrl ? xss(mediaUrl) : null,
            timestamp: Date.now()
        });
    });

    // 3. 游戏与通用应用状态同步频道 (新特性兼容)
    socket.on('game_sync', (data) => {
        const { shortCode, ...payload } = data;
        if (!shortCode) return;
        // 直接转发结构化对象，由 maxHttpBufferSize 保障体积安全，前端自行解构防污染
        socket.to(shortCode).emit('game_sync', {
            ...payload,
            timestamp: Date.now()
        });
    });
});

// ==========================================
// 3. PeerJS 信令服务
// ==========================================
const peerServer = ExpressPeerServer(server, {
    debug: true,
    proxied: true, 
    generateClientId: () => uuidv4(),
});

app.use('/peerjs', peerServer);

peerServer.on('disconnect', (client) => {
    const disconnectedId = client.getId();
    if (!disconnectedId) return;

    // 安全升级：不再一刀切地删除房间。只从列表中移除用户。
    // 如果是房主短暂断线，5分钟内依然可以重连，房间不会立刻销毁。
    for (const shortCode in rooms) {
        const room = rooms[shortCode];
        if (room.clients.includes(disconnectedId)) {
            room.clients = room.clients.filter(id => id !== disconnectedId);
            break;
        }
    }
});

// ==========================================
// 智能房间生命周期管家 (每 30 秒巡检一次)
// ==========================================
setInterval(() => {
    const now = Date.now();
    for (const shortCode in rooms) {
        const room = rooms[shortCode];
        
        // 获取当前该房间中存活的 WebSocket 连接数
        const activeSockets = io.sockets.adapter.rooms.get(shortCode)?.size || 0;
        
        // 如果房间里既没有 Socket 连接，Peer 列表里也没有人，视为“空闲”
        if (activeSockets === 0 && room.clients.length === 0) {
            if (!room.emptySince) {
                // 刚变空，开始倒计时
                room.emptySince = now; 
            } else if (now - room.emptySince > ROOM_EMPTY_TIMEOUT_MS) {
                // 倒计时满 5 分钟，销毁房间
                delete rooms[shortCode];
                console.log(`[Room] 房间 ${shortCode} 空闲超过5分钟，已销毁释放`);
            }
        } else {
            // 只要有人在，立刻打断销毁倒计时
            room.emptySince = null; 
        }

        // 绝对过期时间（24小时），防止异常僵尸房间永久占用内存
        if (now - room.createdAt > ROOM_HARD_EXPIRATION_MS) {
            delete rooms[shortCode];
        }
    }
}, 30 * 1000); 

// ==========================================
// 启动服务器
// ==========================================
server.listen(PORT, '0.0.0.0', () => { 
    console.log(`[Server] 启动成功！`);
    console.log(`[Server] 监听端口: ${PORT}`);
    console.log(`[Server] 安全策略已开启 (5分钟自动回收 / 帧最大 100KB)`);
});