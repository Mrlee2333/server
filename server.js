const http = require('http');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { ExpressPeerServer } = require('peer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io'); 
const xss = require('xss');             

const PORT = process.env.PORT || 8080;
const AUTH_KEY = process.env.AUTH_KEY || 'YOUR_SECRET_KEY'; 

const ROOM_EMPTY_TIMEOUT_MS = 5 * 60 * 1000; 
const ROOM_HARD_EXPIRATION_MS = 24 * 60 * 60 * 1000; 
const MAX_GLOBAL_ROOMS = 2666;
const MAX_PAYLOAD_SIZE = 1e5; 

const rooms = {};

function hashPassword(password) {
    if (!password) return '';
    return crypto.createHash('sha256').update(String(password)).digest('hex');
}

const ipCreationCounts = new Map();

function rateLimitMiddleware(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    
    let userRecords = ipCreationCounts.get(ip) || [];
    userRecords = userRecords.filter(timestamp => now - timestamp < 60 * 60 * 1000);
    
    if (userRecords.length >= 30) {
        return res.status(429).json({ error: '创建房间过于频繁，请稍后再试' });
    }
    
    userRecords.push(now);
    ipCreationCounts.set(ip, userRecords);
    next();
}

setInterval(() => ipCreationCounts.clear(), 2 * 60 * 60 * 1000);

function generateShortCode() {
    return (Math.floor(Math.random() * 900000) + 100000).toString();
}

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = [
    "https://player.arksec.net",
    "https://game.arksec.net"
];

app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST"] }));
app.use(express.json({ limit: '50kb' })); 

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<h1>Nexus Backend is running Securely with Hash Auth</h1>');
});

const serverStartTime = process.hrtime.bigint();
app.get('/get-time', (req, res) => {
    const uptimeNanoseconds = process.hrtime.bigint() - serverStartTime;
    res.json({ serverTime: Number(uptimeNanoseconds) / 1e6 });
});

app.post('/register-room', rateLimitMiddleware, (req, res) => {
    if (Object.keys(rooms).length >= MAX_GLOBAL_ROOMS) {
        return res.status(503).json({ error: '服务器房间容量已满，请稍后再试' });
    }

    const { longId, roomPassword } = req.body;
    if (!longId || !roomPassword) return res.status(400).json({ error: '缺少长ID或房间密码' });
    
    let shortCode;
    do { shortCode = generateShortCode(); } while (rooms[shortCode]);

    rooms[shortCode] = { 
        host: longId, 
        pwdHash: hashPassword(roomPassword),
        createdAt: Date.now(),
        emptySince: null,
        activeSockets: new Set()
    };
    res.status(201).json({ shortCode });
});

app.post('/register-player2', (req, res) => {
    const { shortCode, p2_longId, roomPassword } = req.body;
    if (!shortCode || !p2_longId || !roomPassword) return res.status(400).json({ error: '缺少参数' });

    const room = rooms[shortCode];
    if (!room) return res.status(404).json({ error: '未找到房间或房间已被解散' });

    if (room.pwdHash !== hashPassword(roomPassword)) {
        return res.status(401).json({ error: '房间密码错误' });
    }

    const adapterCount = io.sockets.adapter.rooms.get(shortCode)?.size || 0;
    const trackedCount = room.activeSockets.size;
    const activeSocketsCount = Math.max(adapterCount, trackedCount);

    if (activeSocketsCount >= 2) {
        return res.status(409).json({ error: '当前房间已满员 (Max: 2)' }); 
    }

    room.emptySince = null; 
    res.status(200).send();
});

app.get('/get-room/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const { pwd } = req.query;
    
    const room = rooms[shortCode];
    if (!room) return res.status(404).json({ error: '未找到该房间' });
    
    if (room.pwdHash !== hashPassword(pwd)) {
        return res.status(401).json({ error: '密码错误，拒绝获取房主信令' });
    }

    res.json({ longId: room.host });
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
    transports: ['websocket'],
    allowUpgrades: false,
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: MAX_PAYLOAD_SIZE,
    perMessageDeflate: false 
});

io.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
    if (token === `Bearer ${AUTH_KEY}` || token === AUTH_KEY) return next();
    return next(new Error('Unauthorized: Invalid Server Key'));
});

io.on('connection', (socket) => {
    socket.on('join_room', (data) => {
        if (!data || typeof data !== 'object') return;
        const { shortCode, roomPassword } = data;
        
        const room = rooms[shortCode];
        if (!room) return;

        if (room.pwdHash !== hashPassword(roomPassword)) {
            return; 
        }

        socket.join(shortCode);
        room.activeSockets.add(socket.id);
        room.emptySince = null; 
    });

    socket.on('chat_message', (data) => {
        const { shortCode, message, senderId } = data;
        if (!shortCode || !message || !socket.rooms.has(shortCode)) return;
        
        const safeMessage = xss(message.trim());
        if (safeMessage) {
            io.to(shortCode).emit('chat_message', {
                senderId: xss(senderId),
                message: safeMessage,
                timestamp: Date.now()
            });
        }
    });

    socket.on('media_sync', (data) => {
        const { shortCode, type, action, currentTime, mediaUrl, authPayload, playing } = data;
        if (!shortCode || !socket.rooms.has(shortCode)) return;
        
        socket.to(shortCode).emit('media_sync', {
            type, action, currentTime, playing,
            mediaUrl: mediaUrl ? xss(mediaUrl) : null,
            authPayload: authPayload || null,
            timestamp: Date.now()
        });
    });

    socket.on('game_sync', (data) => {
        const { shortCode, ...payload } = data;
        if (!shortCode || !socket.rooms.has(shortCode)) return;
        
        socket.to(shortCode).emit('game_sync', {
            ...payload,
            timestamp: Date.now()
        });
    });

    socket.on('disconnecting', () => {
        for (const shortCode of socket.rooms) {
            if (rooms[shortCode] && rooms[shortCode].activeSockets) {
                rooms[shortCode].activeSockets.delete(socket.id);
            }
        }
    });
});

const peerServer = ExpressPeerServer(server, {
    debug: false, 
    proxied: true, 
    generateClientId: () => uuidv4(),
    path: '/peerjs'
});

app.use('/peerjs', peerServer);

setInterval(() => {
    const now = Date.now();
    for (const shortCode in rooms) {
        const room = rooms[shortCode];
        
        const adapterCount = io.sockets.adapter.rooms.get(shortCode)?.size || 0;
        const trackedCount = room.activeSockets ? room.activeSockets.size : 0;
        const activeSockets = Math.max(adapterCount, trackedCount);
        
        if (activeSockets === 0) {
            if (!room.emptySince) {
                room.emptySince = now; 
            } else if (now - room.emptySince > ROOM_EMPTY_TIMEOUT_MS) {
                delete rooms[shortCode];
            }
        } else {
            room.emptySince = null; 
        }

        if (rooms[shortCode] && (now - room.createdAt > ROOM_HARD_EXPIRATION_MS)) {
            delete rooms[shortCode];
        }
    }
}, 15 * 1000); 

server.listen(PORT, '0.0.0.0');
