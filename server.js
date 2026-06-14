const http = require('http');
const express = require('express');
const cors = require('cors');
const { ExpressPeerServer } = require('peer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io'); // Socket.io 扩展
const xss = require('xss');             // XSS 防护

// ==========================================
// 环境变量与全局配置
// ==========================================
const PORT = process.env.PORT || 8080;
const AUTH_KEY = process.env.AUTH_KEY || 'YOUR_SECRET_KEY'; // Socket.io 鉴权密钥
const ROOM_EXPIRATION_MS = 2 * 60 * 60 * 1000; // 房间2小时后过期

const rooms = {};

function generateShortCode() {
    return (Math.floor(Math.random() * 900000) + 100000).toString();
}

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. 基础 HTTP 路由 (现有游戏逻辑，保持不变)
// ==========================================
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h1>Server is running (PeerJS + Socket.io Secure)</h1>');
});

const serverStartTime = process.hrtime.bigint();
app.get('/get-time', (req, res) => {
    const uptimeNanoseconds = process.hrtime.bigint() - serverStartTime;
    const serverTimeMilliseconds = Number(uptimeNanoseconds) / 1e6;
    res.json({ serverTime: serverTimeMilliseconds });
});

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
         res.status(409).json({ error: '房间已满或玩家已在房间内' }); 
    } else {
        res.status(404).json({ error: '未找到房间' });
    }
});

app.get('/get-room/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const room = rooms[shortCode];

    if (room) {
        res.json({ longId: room.host });
    } else {
        res.status(404).json({ error: '未找到该房间号或已过期' });
    }
});

const server = http.createServer(app);

// ==========================================
// 2. PeerJS 信令服务 (底层游戏通信)
// ==========================================
const peerServer = ExpressPeerServer(server, {
    debug: true,
    proxied: true,
    generateClientId: uuidv4,
});

app.use('/peerjs', peerServer);

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
}, 60 * 60 * 1000);

// ==========================================
// 3. Socket.io 实时服务 (鉴权、聊天、媒体同步)
// ==========================================
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Socket.io 鉴权中间件
io.use((socket, next) => {
    // 支持 handshake.auth.token (WebSocket) 或 headers.authorization (Polling)
    const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
    
    // 兼容 'Bearer YOUR_SECRET_KEY' 或 'YOUR_SECRET_KEY'
    if (token === `Bearer ${AUTH_KEY}` || token === AUTH_KEY) {
        return next();
    }
    
    console.log(`[Socket] 拒绝未授权连接: Socket ID ${socket.id}`);
    return next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
    console.log(`[Socket] 客户端已连接 (已授权): ${socket.id}`);

    // 绑定业务房间
    socket.on('join_room', (shortCode) => {
        if (!shortCode) return;
        socket.join(shortCode);
        console.log(`[Socket] ${socket.id} 加入房间: ${shortCode}`);
    });

    // 安全聊天转发 (防止 XSS)
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

    // 媒体同步广播 (一起看/一起听)
    socket.on('media_sync', (data) => {
        const { shortCode, type, action, currentTime, mediaUrl } = data;
        if (!shortCode) return;

        // 转发给房间内除了发送者以外的其他人
        socket.to(shortCode).emit('media_sync', {
            type,                 // 'video' 或 'music'
            action,               // 'play', 'pause', 'seek' 等
            currentTime,
            mediaUrl: mediaUrl ? xss(mediaUrl) : null,
            timestamp: Date.now() // 附带服务端时间戳用于网络延迟补偿
        });
    });

    socket.on('disconnect', () => {
        console.log(`[Socket] 客户端已断开: ${socket.id}`);
    });
});

// ==========================================
// 启动服务器
// ==========================================
server.listen(PORT, () => {
    console.log(`[Server] HTTP, PeerJS & Socket.io 已启动`);
    console.log(`[Server] 监听端口: ${PORT}`);
    console.log(`[Server] Auth Key: ${AUTH_KEY.substring(0, 5)}...`);
});