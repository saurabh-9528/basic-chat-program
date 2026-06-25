require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');
const multer = require('multer');
const fs = require('fs');
const { nanoid } = require('nanoid');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET not set in environment. Exiting.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const app = express();

// Apply global rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again after 15 minutes.'
});
app.use(limiter);

const server = http.createServer(app);
const io = new Server(server);

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Serve uploads folder statically
app.use('/uploads', express.static(uploadsDir));

// JWT Authentication Middleware for file uploads
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Unauthorized: Session expired' });
    }
    req.user = decoded;
    next();
  });
};

// Configure Multer storage to preserve filename extensions
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// File validation filter (only images, videos, and PDFs)
const allowedMimeTypes = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'application/pdf'
];
const allowedExtensions = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.mp4', '.webm', '.ogg', '.mov',
  '.pdf'
];

const fileFilter = (req, file, cb) => {
  const fileExtension = path.extname(file.originalname).toLowerCase();
  
  if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.includes(fileExtension)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images, videos, and PDFs are allowed.'));
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// File Upload Endpoint
app.post('/upload', authenticateJWT, (req, res) => {
  upload.single('file')(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File size exceeds 5MB limit.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      if (err.message && err.message.includes('Invalid file type')) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(500).json({ error: 'Internal server error during upload.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size
    });
  });
});

// In-memory data structures
const activeUsers = new Map(); // socket.id -> { username, room, joinedAt }
const MAX_HISTORY_LENGTH = parseInt(process.env.MAX_HISTORY_LENGTH, 10) || 50;

// Setup SQLite database connection
const sqlite3 = require('sqlite3').verbose();
const dbPath = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// Initialize database schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    time TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`, (err) => {
    if (err) {
      console.error('Error creating messages table:', err.message);
    } else {
      // Run table migrations for messages table
      db.all("PRAGMA table_info(messages)", (err, columns) => {
        if (err || !columns) return;
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('file_url')) {
          db.run("ALTER TABLE messages ADD COLUMN file_url TEXT");
        }
        if (!columnNames.includes('file_name')) {
          db.run("ALTER TABLE messages ADD COLUMN file_name TEXT");
        }
        if (!columnNames.includes('file_type')) {
          db.run("ALTER TABLE messages ADD COLUMN file_type TEXT");
        }
        if (!columnNames.includes('file_size')) {
          db.run("ALTER TABLE messages ADD COLUMN file_size INTEGER");
        }
        if (!columnNames.includes('reply_to')) {
          db.run("ALTER TABLE messages ADD COLUMN reply_to TEXT");
        }
        if (!columnNames.includes('reply_to_username')) {
          db.run("ALTER TABLE messages ADD COLUMN reply_to_username TEXT");
        }
        if (!columnNames.includes('reply_to_text')) {
          db.run("ALTER TABLE messages ADD COLUMN reply_to_text TEXT");
        }
        if (!columnNames.includes('is_pinned')) {
          db.run("ALTER TABLE messages ADD COLUMN is_pinned INTEGER DEFAULT 0");
        }
      });
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    avatar_color TEXT,
    status TEXT DEFAULT 'online',
    bio TEXT,
    last_seen INTEGER
  )`, (err) => {
    if (err) {
      console.error('Error creating users table:', err.message);
    } else {
      // Run table migrations for existing databases
      db.all("PRAGMA table_info(users)", (err, columns) => {
        if (err || !columns) return;
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('avatar_color')) {
          db.run("ALTER TABLE users ADD COLUMN avatar_color TEXT");
        }
        if (!columnNames.includes('status')) {
          db.run("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'online'");
        }
        if (!columnNames.includes('bio')) {
          db.run("ALTER TABLE users ADD COLUMN bio TEXT");
        }
        if (!columnNames.includes('last_seen')) {
          db.run("ALTER TABLE users ADD COLUMN last_seen INTEGER");
        }
      });
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, username, emoji)
  )`, (err) => {
    if (err) {
      console.error('Error creating reactions table:', err.message);
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    name TEXT PRIMARY KEY,
    description TEXT,
    password_hash TEXT,
    creator TEXT NOT NULL,
    max_capacity INTEGER DEFAULT 100
  )`, (err) => {
    if (err) {
      console.error('Error creating rooms table:', err.message);
    } else {
      // Pre-populate default rooms
      const defaultRooms = [
        ['Lobby', 'Welcome to the main entry lobby of AetherChat.', null, 'System', 100],
        ['Tech', 'Discuss coding, systems, coffee, and all things tech.', null, 'System', 100],
        ['Random', 'Jokes, casual conversations, memes, and random chatter.', null, 'System', 100]
      ];
      defaultRooms.forEach(([name, desc, pass, creator, cap]) => {
        db.run(
          `INSERT OR IGNORE INTO rooms (name, description, password_hash, creator, max_capacity) VALUES (?, ?, ?, ?, ?)`,
          [name, desc, pass, creator, cap]
        );
      });
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS room_bans (
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (room, username)
  )`, (err) => {
    if (err) {
      console.error('Error creating room_bans table:', err.message);
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS room_mutes (
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    muted_until INTEGER NOT NULL,
    PRIMARY KEY (room, username)
  )`, (err) => {
    if (err) {
      console.error('Error creating room_mutes table:', err.message);
    }
  });
});

// Helper to validate password strength
function validatePasswordStrength(password) {
  if (password.length < 6) {
    return 'Password must be at least 6 characters long.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter.';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number.';
  }
  if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    return 'Password must contain at least one special character.';
  }
  return null;
}

// Helper to validate username format
function validateUsername(username) {
  if (!username) {
    return 'Username is required.';
  }
  const cleanUsername = username.trim();
  if (cleanUsername.length < 3 || cleanUsername.length > 20) {
    return 'Username must be between 3 and 20 characters.';
  }
  const usernameRegex = /^[a-zA-Z0-9 _-]+$/;
  if (!usernameRegex.test(cleanUsername)) {
    return 'Username must contain only letters, numbers, spaces, underscores, or hyphens.';
  }
  return null;
}

// Helper to get all users in a specific room
function getUsersInRoom(room) {
  const users = [];
  activeUsers.forEach((user, socketId) => {
    if (user.room === room) {
      users.push({ id: socketId, username: user.username });
    }
  });
  return users;
}

// Helper to fetch reactions for a list of messages
function fetchReactionsForMessages(messages, callback) {
  if (!messages || messages.length === 0) {
    return callback(null, {});
  }
  const messageIds = messages.map(m => m.id);
  const placeholders = messageIds.map(() => '?').join(',');
  db.all(
    `SELECT message_id, username, emoji FROM reactions WHERE message_id IN (${placeholders})`,
    messageIds,
    (err, rows) => {
      if (err) return callback(err);
      
      const reactionsMap = {};
      rows.forEach(row => {
        if (!reactionsMap[row.message_id]) {
          reactionsMap[row.message_id] = {};
        }
        if (!reactionsMap[row.message_id][row.emoji]) {
          reactionsMap[row.message_id][row.emoji] = [];
        }
        reactionsMap[row.message_id][row.emoji].push(row.username);
      });
      callback(null, reactionsMap);
    }
  );
}

// Helper to fetch and send room history to a specific socket
function sendRoomHistory(socket, room) {
  db.all(
    `SELECT id, username, text, time, timestamp, file_url, file_name, file_type, file_size, reply_to, reply_to_username, reply_to_text, is_pinned FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT ?`,
    [room, MAX_HISTORY_LENGTH],
    (err, rows) => {
      if (err) {
        console.error('Error fetching room history:', err.message);
        socket.emit('roomHistory', []);
        return;
      }
      const reversedRows = rows.reverse();
      fetchReactionsForMessages(reversedRows, (err, reactionsMap) => {
        const history = reversedRows.map(row => ({
          id: row.id,
          username: row.username,
          text: row.text,
          time: row.time,
          timestamp: row.timestamp,
          system: false,
          fileUrl: row.file_url,
          fileName: row.file_name,
          fileType: row.file_type,
          fileSize: row.file_size,
          replyTo: row.reply_to,
          replyToUsername: row.reply_to_username,
          replyToText: row.reply_to_text,
          isPinned: row.is_pinned === 1,
          reactions: reactionsMap ? (reactionsMap[row.id] || {}) : {}
        }));
        socket.emit('roomHistory', history);
      });
    }
  );
}

// Helper to broadcast global active user list to everyone
function broadcastGlobalUsers() {
  db.all(
    `SELECT username, bio, status, avatar_color, last_seen FROM users ORDER BY username ASC`,
    [],
    (err, rows) => {
      if (err || !rows) {
        console.error('Failed to fetch users for broadcast:', err ? err.message : 'No users found');
        return;
      }

      // Map rows, check if each user is currently online
      const usersList = rows.map(row => {
        let isOnline = false;
        let currentStatus = 'offline';
        let currentBio = row.bio || '';
        let currentColor = row.avatar_color;

        // Loop activeUsers to check if online
        for (const activeUser of activeUsers.values()) {
          if (activeUser.username.toLowerCase() === row.username.toLowerCase()) {
            isOnline = true;
            currentStatus = activeUser.status || 'online'; // online/away/busy
            currentBio = activeUser.bio || '';
            currentColor = activeUser.avatarColor || row.avatar_color;
            break;
          }
        }

        return {
          username: row.username,
          bio: currentBio,
          status: isOnline ? currentStatus : 'offline',
          avatarColor: currentColor,
          lastSeen: isOnline ? null : row.last_seen
        };
      });

      io.emit('globalUsers', usersList);
    }
  );
}

// Helper to complete user registration / join flow
function completeUserJoin(socket, username, room, bio = '', status = 'online', avatarColor = null) {
  // Join the user's private channel for DMs
  socket.join(`user:${username.toLowerCase()}`);

  socket.join(room);
  activeUsers.set(socket.id, {
    username,
    room,
    joinedAt: new Date(),
    bio,
    status,
    avatarColor
  });

  console.log(`${username} joined room: ${room}`);

  // Emit success back to the joining client with JWT token
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
  socket.emit('joinSuccess', { username, room, token, bio, status, avatarColor });

  // 1. Send room history
  sendRoomHistory(socket, room);

  // 2. Broadcast welcome/join messages
  if (!room.startsWith('dm:')) {
    socket.to(room).emit('message', {
      system: true,
      text: `${username} has joined the chat.`
    });

    socket.emit('message', {
      system: true,
      text: `Welcome to the ${room} room, ${username}!`
    });
  } else {
    // Send a DM introduction system message
    const parts = room.split(':');
    const recipient = parts[1].toLowerCase() === username.toLowerCase() ? parts[2] : parts[1];
    let capitalizedRecipient = recipient.charAt(0).toUpperCase() + recipient.slice(1);
    for (const u of activeUsers.values()) {
      if (u.username.toLowerCase() === recipient.toLowerCase()) {
        capitalizedRecipient = u.username;
        break;
      }
    }
    socket.emit('message', {
      system: true,
      text: `This is the start of your direct message history with ${capitalizedRecipient}.`
    });
  }

  // 3. Broadcast updated global user list to everyone
  broadcastGlobalUsers();
  
  // 4. Broadcast dynamic rooms list
  broadcastRoomsList();
}

// Helper to broadcast global rooms list to everyone (or just one socket)
function broadcastRoomsList(targetSocket = null) {
  db.all(`SELECT name, description, creator, max_capacity, (password_hash IS NOT NULL AND password_hash != '') as has_password FROM rooms`, [], (err, rows) => {
    if (err) {
      console.error('Error fetching rooms list for broadcast:', err.message);
      return;
    }
    
    const roomsList = (rows || []).map(row => {
      let activeCount = 0;
      activeUsers.forEach(u => {
        if (u.room === row.name) activeCount++;
      });
      
      return {
        name: row.name,
        description: row.description || '',
        creator: row.creator,
        maxCapacity: row.max_capacity,
        hasPassword: row.has_password === 1,
        activeCount
      };
    });
    
    if (targetSocket) {
      targetSocket.emit('roomsList', roomsList);
    } else {
      io.emit('roomsList', roomsList);
    }
  });
}

// Helper to verify if a user is allowed to join a room (checks password, ban, capacity)
function verifyAndJoinRoom(username, roomName, roomPassword, callback) {
  if (roomName.startsWith('dm:')) {
    return callback(null);
  }

  db.get(`SELECT * FROM rooms WHERE name = ?`, [roomName], (err, roomRow) => {
    if (err) {
      return callback('Database error while joining room.');
    }
    if (!roomRow) {
      return callback('Room does not exist.');
    }

    // 1. Check ban list
    db.get(
      `SELECT 1 FROM room_bans WHERE room = ? AND LOWER(username) = ?`,
      [roomName, username.toLowerCase()],
      (err, banRow) => {
        if (err) {
          return callback('Database error while checking bans.');
        }
        if (banRow) {
          return callback('You are banned from this room.');
        }

        // 2. Check capacity limits
        let activeCount = 0;
        activeUsers.forEach(u => {
          if (u.room === roomName) activeCount++;
        });
        if (activeCount >= roomRow.max_capacity) {
          return callback('Room is full.');
        }

        // 3. Check password
        if (roomRow.password_hash) {
          if (!roomPassword) {
            return callback('Password required to join this room.');
          }
          bcrypt.compare(roomPassword, roomRow.password_hash, (err, isMatch) => {
            if (err) {
              return callback('Authentication check error.');
            }
            if (!isMatch) {
              return callback('Incorrect room password.');
            }
            callback(null);
          });
        } else {
          callback(null);
        }
      }
    );
  });
}

// Helper to fetch and broadcast reaction updates
function broadcastReactionUpdate(room, messageId) {
  db.all(
    `SELECT username, emoji FROM reactions WHERE message_id = ?`,
    [messageId],
    (err, rows) => {
      if (err) {
        console.error('Error fetching reactions for update:', err.message);
        return;
      }

      const reactions = {};
      rows.forEach(row => {
        if (!reactions[row.emoji]) {
          reactions[row.emoji] = [];
        }
        reactions[row.emoji].push(row.username);
      });

      io.to(room).emit('reactionUpdate', { messageId, reactions });
    }
  );
}

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Handle joining a room
  socket.on('joinRoom', ({ username, password, token, room, roomPassword, action }) => {
    // Validate inputs
    const cleanUsername = username?.trim().substring(0, 20) || '';
    const usernameError = validateUsername(cleanUsername);
    if (usernameError) {
      socket.emit('joinError', usernameError);
      return;
    }
    
    // Validate cleanRoom
    let cleanRoom = room || 'Lobby';
    if (room && room.startsWith('dm:')) {
      const parts = room.split(':');
      if (parts.length === 3) {
        const sortedUsers = [parts[1], parts[2]].sort();
        cleanRoom = `dm:${sortedUsers[0]}:${sortedUsers[1]}`;
      } else {
        cleanRoom = 'Lobby';
      }
    }

    const existingUser = activeUsers.get(socket.id);

    // If socket is already logged in with this username, it's just switching rooms
    if (existingUser && existingUser.username.toLowerCase() === cleanUsername.toLowerCase()) {
      verifyAndJoinRoom(existingUser.username, cleanRoom, roomPassword, (err) => {
        if (err) {
          socket.emit('joinError', err);
          return;
        }

        socket.leave(existingUser.room);
        // Notify previous room (only if not a DM room)
        if (!existingUser.room.startsWith('dm:')) {
          io.to(existingUser.room).emit('message', {
            system: true,
            text: `${existingUser.username} has left the chat.`
          });
        }
        // Update previous room user list
        io.to(existingUser.room).emit('roomUsers', {
          room: existingUser.room,
          users: getUsersInRoom(existingUser.room)
        });

        // Join new room
        socket.join(cleanRoom);
        activeUsers.set(socket.id, {
          ...existingUser,
          room: cleanRoom
        });

        console.log(`${existingUser.username} switched to room: ${cleanRoom}`);

        // Emit success back to the joining client with a new token
        const token = jwt.sign({ username: existingUser.username }, JWT_SECRET, { expiresIn: '7d' });
        socket.emit('joinSuccess', {
          username: existingUser.username,
          room: cleanRoom,
          token,
          bio: existingUser.bio,
          status: existingUser.status,
          avatarColor: existingUser.avatarColor
        });

        // Broadcast updated global user list and rooms list (updates active counts)
        broadcastGlobalUsers();
        broadcastRoomsList();

        // Send room history
        sendRoomHistory(socket, cleanRoom);

        // Broadcast welcome/join message
        if (!cleanRoom.startsWith('dm:')) {
          socket.to(cleanRoom).emit('message', {
            system: true,
            text: `${existingUser.username} has joined the chat.`
          });

          socket.emit('message', {
            system: true,
            text: `Welcome to the ${cleanRoom} room, ${existingUser.username}!`
          });
        } else {
          const parts = cleanRoom.split(':');
          const recipient = parts[1].toLowerCase() === existingUser.username.toLowerCase() ? parts[2] : parts[1];
          let capitalizedRecipient = recipient.charAt(0).toUpperCase() + recipient.slice(1);
          for (const u of activeUsers.values()) {
            if (u.username.toLowerCase() === recipient.toLowerCase()) {
              capitalizedRecipient = u.username;
              break;
            }
          }
          socket.emit('message', {
            system: true,
            text: `This is the start of your direct message history with ${capitalizedRecipient}.`
          });
        }
      });
      return;
    }

    // Token-based auto-login verification
    if (token) {
      jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
          socket.emit('joinError', 'Session expired. Please log in again.');
          return;
        }
        if (decoded.username.toLowerCase() !== cleanUsername.toLowerCase()) {
          socket.emit('joinError', 'Invalid session credentials.');
          return;
        }

        // Check if username is already active in another session
        const isAlreadyActive = Array.from(activeUsers.entries()).some(
          ([id, user]) => user.username.toLowerCase() === cleanUsername.toLowerCase() && id !== socket.id
        );
        if (isAlreadyActive) {
          socket.emit('joinError', `Username "${cleanUsername}" is already active in another session.`);
          return;
        }

        // Fetch profile
        db.get(`SELECT bio, status, avatar_color FROM users WHERE LOWER(username) = ?`, [cleanUsername.toLowerCase()], (err, userRow) => {
          const profile = userRow || { bio: '', status: 'online', avatar_color: null };
          
          verifyAndJoinRoom(decoded.username, cleanRoom, roomPassword, (err) => {
            if (err) {
              socket.emit('joinError', err);
              return;
            }
            completeUserJoin(socket, decoded.username, cleanRoom, profile.bio, profile.status, profile.avatar_color);
          });
        });
      });
      return;
    }

    // New connection password validation
    if (!password || password.trim() === '') {
      socket.emit('joinError', 'Password is required.');
      return;
    }

    // Check if username is already active by another socket
    const isAlreadyActive = Array.from(activeUsers.entries()).some(
      ([id, user]) => user.username.toLowerCase() === cleanUsername.toLowerCase() && id !== socket.id
    );
    if (isAlreadyActive) {
      socket.emit('joinError', `Username "${cleanUsername}" is already active in another session.`);
      return;
    }

    // Check user database
    db.get(`SELECT password_hash, bio, status, avatar_color FROM users WHERE LOWER(username) = ?`, [cleanUsername.toLowerCase()], (err, userRow) => {
      if (err) {
        console.error('Database error on joinRoom:', err.message);
        socket.emit('joinError', 'Internal server database error.');
        return;
      }

      if (userRow) {
        // User exists
        if (action === 'register') {
          socket.emit('joinError', 'Username is already taken. Please choose another or log in.');
          return;
        }

        // Verify password
        bcrypt.compare(password, userRow.password_hash, (err, matches) => {
          if (err) {
            console.error('Bcrypt compare error:', err);
            socket.emit('joinError', 'Internal authentication error.');
            return;
          }
          if (!matches) {
            socket.emit('joinError', 'Incorrect password for this username.');
            return;
          }

          // Password matched, verify room is allowed
          verifyAndJoinRoom(cleanUsername, cleanRoom, roomPassword, (err) => {
            if (err) {
              socket.emit('joinError', err);
              return;
            }
            completeUserJoin(socket, cleanUsername, cleanRoom, userRow.bio, userRow.status, userRow.avatar_color);
          });
        });
      } else {
        // User does not exist
        if (action === 'login') {
          socket.emit('joinError', 'Username does not exist. Please register first.');
          return;
        }

        // Register new user (validate strength first)
        const passwordError = validatePasswordStrength(password);
        if (passwordError) {
          socket.emit('joinError', passwordError);
          return;
        }

        bcrypt.hash(password, 10, (err, hash) => {
          if (err) {
            console.error('Bcrypt hash error:', err);
            socket.emit('joinError', 'Internal registration error.');
            return;
          }

          db.run(
            `INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`,
            [cleanUsername, hash, Date.now()],
            (err) => {
              if (err) {
                console.error('Database insert user error:', err.message);
                socket.emit('joinError', 'Failed to register username.');
                return;
              }

              // Register complete, verify room allowed
              verifyAndJoinRoom(cleanUsername, cleanRoom, roomPassword, (err) => {
                if (err) {
                  socket.emit('joinError', err);
                  return;
                }
                completeUserJoin(socket, cleanUsername, cleanRoom, '', 'online', null);
              });
            }
          );
        });
      }
    });
  });

  // Handle incoming chat messages
  socket.on('chatMessage', (data) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    // Rate Limiting (sliding window: max 5 messages in 5 seconds)
    const now = Date.now();
    user.messageTimestamps = (user.messageTimestamps || []).filter(t => now - t < 5000);

    if (user.messageTimestamps.length >= 5) {
      socket.emit('message', {
        system: true,
        text: 'You are sending messages too fast. Please slow down.'
      });
      return;
    }

    user.messageTimestamps.push(now);

    const timestamp = now;

    let rawText = '';
    let file = null;
    let replyTo = null;
    let replyToUsername = null;
    let replyToText = null;

    if (typeof data === 'string') {
      rawText = data;
    } else if (data && typeof data === 'object') {
      rawText = data.text || '';
      if (data.file && typeof data.file === 'object') {
        if (data.file.url && !data.file.url.startsWith('/uploads/')) return;
        file = {
          url: data.file.url,
          name: data.file.name,
          type: data.file.type,
          size: data.file.size
        };
      }
      replyTo = data.replyTo || null;
      replyToUsername = data.replyToUsername ? String(data.replyToUsername).substring(0, 20) : null;
      replyToText = data.replyToText ? String(data.replyToText).substring(0, 200) : null;
    }

    // Always enforce user's current room to prevent writing to unauthorized rooms
    const targetRoom = user.room;

    // Sanitize message text to strip all HTML tags (XSS prevention)
    const sanitizedText = sanitizeHtml(rawText.substring(0, 1000), {
      allowedTags: [],
      allowedAttributes: {}
    });

    // Check mute status before saving/broadcasting
    db.get(
      `SELECT muted_until FROM room_mutes WHERE room = ? AND LOWER(username) = ?`,
      [targetRoom, user.username.toLowerCase()],
      (err, muteRow) => {
        if (err) {
          console.error('Failed to check mute status:', err.message);
          return;
        }

        if (muteRow && Date.now() < muteRow.muted_until) {
          const remainingSecs = Math.ceil((muteRow.muted_until - Date.now()) / 1000);
          socket.emit('message', {
            system: true,
            text: `You are muted in this room. You can chat again in ${remainingSecs} seconds.`
          });
          return;
        }

        if (!sanitizedText.trim() && !file) return;

        const message = {
          id: nanoid(),
          username: user.username,
          text: sanitizedText,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          timestamp: timestamp,
          system: false,
          fileUrl: file ? file.url : null,
          fileName: file ? file.name : null,
          fileType: file ? file.type : null,
          fileSize: file ? file.size : null,
          replyTo: replyTo,
          replyToUsername: replyToUsername,
          replyToText: replyToText,
          isPinned: false,
          reactions: {}
        };

        // Store in SQLite database
        db.run(
          `INSERT INTO messages (id, room, username, text, time, timestamp, file_url, file_name, file_type, file_size, reply_to, reply_to_username, reply_to_text, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [message.id, targetRoom, message.username, message.text, message.time, timestamp, message.fileUrl, message.fileName, message.fileType, message.fileSize, message.replyTo, message.replyToUsername, message.replyToText, 0],
          (err) => {
            if (err) {
              console.error('Failed to save message:', err.message);
            }
          }
        );

        // Broadcast message to room
        io.to(targetRoom).emit('message', message);

        // Check for @mentions and notify users
        const words = sanitizedText.split(/\s+/);
        const mentions = [];
        words.forEach(word => {
          if (word.startsWith('@')) {
            const potentialUser = word.substring(1).replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
            mentions.push(potentialUser.toLowerCase());
          }
        });

        if (mentions.length > 0) {
          activeUsers.forEach((activeUser, socketId) => {
            // Don't notify the sender themselves
            if (socketId !== socket.id && mentions.includes(activeUser.username.toLowerCase())) {
              io.to(socketId).emit('mentionNotification', {
                sender: message.username,
                room: targetRoom,
                text: message.text,
                messageId: message.id
              });
            }
          });
        }
      }
    );
  });

  // Handle searching messages
  socket.on('searchMessages', ({ room, query }) => {
    const user = activeUsers.get(socket.id);
    if (!user || typeof room !== 'string' || !room.trim() || typeof query !== 'string' || !query.trim() || user.room !== room) return;

    db.all(
      `SELECT id, username, text, time, timestamp, file_url, file_name, file_type, file_size, reply_to, reply_to_username, reply_to_text, is_pinned FROM messages WHERE room = ? AND text LIKE ? ORDER BY timestamp DESC LIMIT 100`,
      [room, `%${query}%`],
      (err, rows) => {
        if (err) {
          console.error('Error searching messages:', err.message);
          socket.emit('searchResults', { query, results: [] });
          return;
        }
        const reversedRows = rows.reverse();
        fetchReactionsForMessages(reversedRows, (err, reactionsMap) => {
          const results = reversedRows.map(row => ({
            id: row.id,
            username: row.username,
            text: row.text,
            time: row.time,
            timestamp: row.timestamp,
            system: false,
            fileUrl: row.file_url,
            fileName: row.file_name,
            fileType: row.file_type,
            fileSize: row.file_size,
            replyTo: row.reply_to,
            replyToUsername: row.reply_to_username,
            replyToText: row.reply_to_text,
            isPinned: row.is_pinned === 1,
            reactions: reactionsMap ? (reactionsMap[row.id] || {}) : {}
          }));
          socket.emit('searchResults', { query, results });
        });
      }
    );
  });

  // Handle loading older messages (lazy loading / infinite scroll)
  socket.on('loadMoreMessages', ({ room, beforeTimestamp }) => {
    const user = activeUsers.get(socket.id);
    if (!user || typeof room !== 'string' || !room.trim() || typeof beforeTimestamp !== 'number' || isNaN(beforeTimestamp) || user.room !== room) return;

    db.all(
      `SELECT id, username, text, time, timestamp, file_url, file_name, file_type, file_size, reply_to, reply_to_username, reply_to_text, is_pinned FROM messages WHERE room = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 50`,
      [room, beforeTimestamp],
      (err, rows) => {
        if (err) {
          console.error('Error loading older messages:', err.message);
          socket.emit('moreMessages', { results: [] });
          return;
        }
        const reversedRows = rows.reverse();
        fetchReactionsForMessages(reversedRows, (err, reactionsMap) => {
          const results = reversedRows.map(row => ({
            id: row.id,
            username: row.username,
            text: row.text,
            time: row.time,
            timestamp: row.timestamp,
            system: false,
            fileUrl: row.file_url,
            fileName: row.file_name,
            fileType: row.file_type,
            fileSize: row.file_size,
            replyTo: row.reply_to,
            replyToUsername: row.reply_to_username,
            replyToText: row.reply_to_text,
            isPinned: row.is_pinned === 1,
            reactions: reactionsMap ? (reactionsMap[row.id] || {}) : {}
          }));
          socket.emit('moreMessages', { results });
        });
      }
    );
  });

  // Handle jumping/filtering by date
  socket.on('getMessagesByDate', ({ room, date, start, end }) => {
    const user = activeUsers.get(socket.id);
    if (!user || typeof room !== 'string' || !room.trim() || typeof date !== 'string' || !date.trim() || user.room !== room) return;

    let queryStart = start;
    let queryEnd = end;

    if (queryStart === undefined || queryEnd === undefined) {
      // Fallback: Convert date string 'YYYY-MM-DD' to start and end of that day in server timezone
      const dateParts = date.split('-');
      if (dateParts.length !== 3) return;
      const year = parseInt(dateParts[0], 10);
      const month = parseInt(dateParts[1], 10) - 1; // 0-based
      const day = parseInt(dateParts[2], 10);

      queryStart = new Date(year, month, day, 0, 0, 0, 0).getTime();
      queryEnd = new Date(year, month, day, 23, 59, 59, 999).getTime();
    }

    db.all(
      `SELECT id, username, text, time, timestamp, file_url, file_name, file_type, file_size, reply_to, reply_to_username, reply_to_text, is_pinned FROM messages WHERE room = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
      [room, queryStart, queryEnd],
      (err, rows) => {
        if (err) {
          console.error('Error fetching messages by date:', err.message);
          socket.emit('dateMessages', { date, results: [] });
          return;
        }
        fetchReactionsForMessages(rows, (err, reactionsMap) => {
          const results = rows.map(row => ({
            id: row.id,
            username: row.username,
            text: row.text,
            time: row.time,
            timestamp: row.timestamp,
            system: false,
            fileUrl: row.file_url,
            fileName: row.file_name,
            fileType: row.file_type,
            fileSize: row.file_size,
            replyTo: row.reply_to,
            replyToUsername: row.reply_to_username,
            replyToText: row.reply_to_text,
            isPinned: row.is_pinned === 1,
            reactions: reactionsMap ? (reactionsMap[row.id] || {}) : {}
          }));
          socket.emit('dateMessages', { date, results });
        });
      }
    );
  });

  // Handle typing indicator
  socket.on('typing', (isTyping) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    // Broadcast typing status to everyone in the room except the typing user
    socket.to(user.room).emit('typingStatus', {
      username: user.username,
      isTyping
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      console.log(`${user.username} disconnected`);
      
      const disconnectTime = Date.now();
      
      // Update last_seen in DB
      db.run(
        `UPDATE users SET last_seen = ? WHERE LOWER(username) = ?`,
        [disconnectTime, user.username.toLowerCase()],
        (err) => {
          if (err) {
            console.error('Failed to update last_seen:', err.message);
          }
        }
      );

      // Notify room (only if not a DM room)
      if (!user.room.startsWith('dm:')) {
        io.to(user.room).emit('message', {
          system: true,
          text: `${user.username} has left the chat.`
        });
      }

      // Remove user
      activeUsers.delete(socket.id);

      // Broadcast updated global user list to everyone
      broadcastGlobalUsers();
      
      // Broadcast updated rooms list
      broadcastRoomsList();
    }
  });

  // Handle profile updates
  socket.on('updateProfile', ({ bio, status, avatarColor }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    // Sanitize bio
    const sanitizedBio = sanitizeHtml(bio?.substring(0, 150) || '', {
      allowedTags: [],
      allowedAttributes: {}
    });

    // Validate status
    const validStatuses = ['online', 'away', 'busy'];
    const finalStatus = validStatuses.includes(status) ? status : 'online';

    // Validate hex color
    const colorRegex = /^#[0-9A-F]{6}$/i;
    const finalColor = colorRegex.test(avatarColor) ? avatarColor : null;

    db.run(
      `UPDATE users SET bio = ?, status = ?, avatar_color = ? WHERE LOWER(username) = ?`,
      [sanitizedBio, finalStatus, finalColor, user.username.toLowerCase()],
      (err) => {
        if (err) {
          console.error('Failed to update profile in DB:', err.message);
          socket.emit('profileUpdateError', 'Failed to update profile. Please try again.');
          return;
        }

        // Update in activeUsers memory
        user.bio = sanitizedBio;
        user.status = finalStatus;
        user.avatarColor = finalColor;

        socket.emit('profileUpdateSuccess', { bio: sanitizedBio, status: finalStatus, avatarColor: finalColor });

        // Broadcast updated user list to all connected clients
        broadcastGlobalUsers();
      }
    );
  });

  // Handle toggling reaction on a message
  socket.on('toggleReaction', ({ messageId, emoji }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !emoji || typeof emoji !== 'string' || emoji.length > 10) return;

    // Verify the message belongs to the user's room
    db.get(
      `SELECT room FROM messages WHERE id = ?`,
      [messageId],
      (err, msgRow) => {
        if (err || !msgRow || msgRow.room !== user.room) return;

        db.get(
          `SELECT * FROM reactions WHERE message_id = ? AND username = ? AND emoji = ?`,
          [messageId, user.username, emoji],
          (err, row) => {
            if (err) {
              console.error('Error querying reaction:', err.message);
              return;
            }

            if (row) {
              // Reaction exists, remove it
              db.run(
                `DELETE FROM reactions WHERE message_id = ? AND username = ? AND emoji = ?`,
                [messageId, user.username, emoji],
                (err) => {
                  if (err) console.error('Error removing reaction:', err.message);
                  broadcastReactionUpdate(user.room, messageId);
                }
              );
            } else {
              // Reaction does not exist, add it
              db.run(
                `INSERT INTO reactions (message_id, username, emoji) VALUES (?, ?, ?)`,
                [messageId, user.username, emoji],
                (err) => {
                  if (err) console.error('Error adding reaction:', err.message);
                  broadcastReactionUpdate(user.room, messageId);
                }
              );
            }
          }
        );
      }
    );
  });

  // Handle toggling pin status of a message
  socket.on('togglePinMessage', ({ messageId }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    db.get(
      `SELECT is_pinned, room FROM messages WHERE id = ?`,
      [messageId],
      (err, row) => {
        if (err) {
          console.error('Error fetching message for pinning:', err.message);
          return;
        }
        if (!row || row.room !== user.room) return;

        const newPinStatus = row.is_pinned === 1 ? 0 : 1;
        db.run(
          `UPDATE messages SET is_pinned = ? WHERE id = ?`,
          [newPinStatus, messageId],
          (err) => {
            if (err) {
              console.error('Error updating pin status:', err.message);
              return;
            }
            io.to(row.room).emit('pinUpdate', { messageId, isPinned: newPinStatus === 1 });
          }
        );
      }
    );
  });

  // Handle getting all pinned messages for a room
  socket.on('getPinnedMessages', ({ room }) => {
    const user = activeUsers.get(socket.id);
    if (!user || typeof room !== 'string' || !room.trim() || user.room !== room) return;

    db.all(
      `SELECT id, username, text, time, timestamp, file_url, file_name, file_type, file_size, reply_to, reply_to_username, reply_to_text, is_pinned FROM messages WHERE room = ? AND is_pinned = 1 ORDER BY timestamp DESC`,
      [room],
      (err, rows) => {
        if (err) {
          console.error('Error fetching pinned messages:', err.message);
          socket.emit('pinnedMessages', { room, results: [] });
          return;
        }
        fetchReactionsForMessages(rows, (err, reactionsMap) => {
          const results = rows.map(row => ({
            id: row.id,
            username: row.username,
            text: row.text,
            time: row.time,
            timestamp: row.timestamp,
            system: false,
            fileUrl: row.file_url,
            fileName: row.file_name,
            fileType: row.file_type,
            fileSize: row.file_size,
            replyTo: row.reply_to,
            replyToUsername: row.reply_to_username,
            replyToText: row.reply_to_text,
            isPinned: row.is_pinned === 1,
            reactions: reactionsMap ? (reactionsMap[row.id] || {}) : {}
          }));
          socket.emit('pinnedMessages', { room, results });
        });
      }
    );
  });

  // Handle getting rooms list
  socket.on('getRoomsList', () => {
    broadcastRoomsList(socket);
  });

  // Handle creating a room
  socket.on('createRoom', ({ name, description, password, maxCapacity }) => {
    const user = activeUsers.get(socket.id);
    if (!user) {
      socket.emit('createRoomError', 'Not authenticated.');
      return;
    }

    const cleanName = name?.trim();
    if (!cleanName || cleanName.length < 3 || cleanName.length > 20) {
      socket.emit('createRoomError', 'Room name must be between 3 and 20 characters.');
      return;
    }

    if (!/^[a-zA-Z0-9 _-]+$/.test(cleanName)) {
      socket.emit('createRoomError', 'Room name can only contain letters, numbers, spaces, underscores, or hyphens.');
      return;
    }

    if (cleanName.toLowerCase().startsWith('dm:')) {
      socket.emit('createRoomError', 'Invalid room name.');
      return;
    }

    const cleanDesc = description?.trim().substring(0, 150) || '';
    const cap = parseInt(maxCapacity, 10) || 100;
    if (cap < 2 || cap > 1000) {
      socket.emit('createRoomError', 'Capacity must be between 2 and 1000.');
      return;
    }

    // Check if room already exists
    db.get(`SELECT 1 FROM rooms WHERE LOWER(name) = ?`, [cleanName.toLowerCase()], (err, row) => {
      if (err) {
        socket.emit('createRoomError', 'Database error.');
        return;
      }
      if (row) {
        socket.emit('createRoomError', 'A room with this name already exists.');
        return;
      }

      const insertRoom = (hash) => {
        db.run(
          `INSERT INTO rooms (name, description, password_hash, creator, max_capacity) VALUES (?, ?, ?, ?, ?)`,
          [cleanName, cleanDesc, hash, user.username, cap],
          (err) => {
            if (err) {
              socket.emit('createRoomError', 'Failed to create room.');
              return;
            }
            socket.emit('createRoomSuccess', { roomName: cleanName });
            broadcastRoomsList();
          }
        );
      };

      if (password && password.trim() !== '') {
        bcrypt.hash(password, 10, (err, hash) => {
          if (err) {
            socket.emit('createRoomError', 'Failed to secure room.');
            return;
          }
          insertRoom(hash);
        });
      } else {
        insertRoom(null);
      }
    });
  });

  // Handle deleting a room
  socket.on('deleteRoom', ({ roomName }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    db.get(`SELECT creator FROM rooms WHERE name = ?`, [roomName], (err, roomRow) => {
      if (err || !roomRow) {
        socket.emit('deleteRoomError', 'Room not found or database error.');
        return;
      }

      const isCreator = roomRow.creator.toLowerCase() === user.username.toLowerCase();
      const isDefault = ['Lobby', 'Tech', 'Random'].includes(roomName);

      if (isDefault) {
        socket.emit('deleteRoomError', 'Default system rooms cannot be deleted.');
        return;
      }

      if (!isCreator) {
        socket.emit('deleteRoomError', 'Only the room creator can delete this room.');
        return;
      }

      // Delete room from database
      db.serialize(() => {
        db.run(`DELETE FROM rooms WHERE name = ?`, [roomName]);
        db.run(`DELETE FROM room_bans WHERE room = ?`, [roomName]);
        db.run(`DELETE FROM room_mutes WHERE room = ?`, [roomName]);
      });

      // Find all active sockets in this room and force them to Lobby
      activeUsers.forEach((activeUser, socketId) => {
        if (activeUser.room === roomName) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) {
            targetSocket.leave(roomName);
            targetSocket.join('Lobby');
            activeUser.room = 'Lobby';
            targetSocket.emit('forcedJoinLobby', {
              message: `The room "${roomName}" was deleted by its creator.`
            });
            sendRoomHistory(targetSocket, 'Lobby');
            targetSocket.to('Lobby').emit('message', {
              system: true,
              text: `${activeUser.username} has joined the chat.`
            });
            targetSocket.emit('message', {
              system: true,
              text: `Welcome to the Lobby room, ${activeUser.username}!`
            });
            io.to('Lobby').emit('roomUsers', {
              room: 'Lobby',
              users: getUsersInRoom('Lobby')
            });
          }
        }
      });

      broadcastRoomsList();
    });
  });

  // Handle kicking a user
  socket.on('kickUser', ({ roomName, targetUsername }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    db.get(`SELECT creator FROM rooms WHERE name = ?`, [roomName], (err, roomRow) => {
      if (err) {
        socket.emit('moderationError', 'Database error while searching for the room.');
        return;
      }
      if (!roomRow) {
        socket.emit('moderationError', 'Room does not exist.');
        return;
      }

      if (roomRow.creator.toLowerCase() !== user.username.toLowerCase()) {
         socket.emit('moderationError', 'You do not have moderator permissions in this room.');
         return;
      }

      if (user.username.toLowerCase() === targetUsername.toLowerCase()) {
         socket.emit('moderationError', 'You cannot kick yourself.');
         return;
      }

      let targetSocketId = null;
      activeUsers.forEach((activeUser, sId) => {
         if (activeUser.room === roomName && activeUser.username.toLowerCase() === targetUsername.toLowerCase()) {
           targetSocketId = sId;
         }
      });

      if (targetSocketId) {
         const targetSocket = io.sockets.sockets.get(targetSocketId);
         if (targetSocket) {
           targetSocket.leave(roomName);
           targetSocket.join('Lobby');
           const activeUser = activeUsers.get(targetSocketId);
           activeUser.room = 'Lobby';
           targetSocket.emit('forcedJoinLobby', {
             message: `You were kicked from room "${roomName}" by the creator.`
           });
           sendRoomHistory(targetSocket, 'Lobby');
           targetSocket.to('Lobby').emit('message', {
             system: true,
             text: `${activeUser.username} has joined the chat.`
           });
           targetSocket.emit('message', {
             system: true,
             text: `Welcome to the Lobby room, ${activeUser.username}!`
           });
           io.to('Lobby').emit('roomUsers', {
             room: 'Lobby',
             users: getUsersInRoom('Lobby')
           });
           io.to(roomName).emit('message', {
             system: true,
             text: `${targetUsername} was kicked from the room by the creator.`
           });
           io.to(roomName).emit('roomUsers', {
             room: roomName,
             users: getUsersInRoom(roomName)
           });
           broadcastRoomsList();
         }
      }
    });
  });

  // Handle banning a user
  socket.on('banUser', ({ roomName, targetUsername }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    db.get(`SELECT creator FROM rooms WHERE name = ?`, [roomName], (err, roomRow) => {
      if (err) {
        socket.emit('moderationError', 'Database error while searching for the room.');
        return;
      }
      if (!roomRow) {
        socket.emit('moderationError', 'Room does not exist.');
        return;
      }

      if (roomRow.creator.toLowerCase() !== user.username.toLowerCase()) {
         socket.emit('moderationError', 'You do not have moderator permissions in this room.');
         return;
      }

      if (user.username.toLowerCase() === targetUsername.toLowerCase()) {
         socket.emit('moderationError', 'You cannot ban yourself.');
         return;
      }

      db.run(
         `INSERT OR IGNORE INTO room_bans (room, username) VALUES (?, ?)`,
         [roomName, targetUsername.toLowerCase()],
         (err) => {
           if (err) {
             socket.emit('moderationError', 'Failed to ban user in database.');
             return;
           }

           io.to(roomName).emit('message', {
             system: true,
             text: `${targetUsername} was banned from the room by the creator.`
           });

           let targetSocketId = null;
           activeUsers.forEach((activeUser, sId) => {
             if (activeUser.room === roomName && activeUser.username.toLowerCase() === targetUsername.toLowerCase()) {
               targetSocketId = sId;
             }
           });

           if (targetSocketId) {
             const targetSocket = io.sockets.sockets.get(targetSocketId);
             if (targetSocket) {
               targetSocket.leave(roomName);
               targetSocket.join('Lobby');
               const activeUser = activeUsers.get(targetSocketId);
               activeUser.room = 'Lobby';
               targetSocket.emit('forcedJoinLobby', {
                 message: `You were banned from room "${roomName}" by the creator.`
               });
               sendRoomHistory(targetSocket, 'Lobby');
               targetSocket.to('Lobby').emit('message', {
                 system: true,
                 text: `${activeUser.username} has joined the chat.`
               });
               targetSocket.emit('message', {
                 system: true,
                 text: `Welcome to the Lobby room, ${activeUser.username}!`
               });
               io.to('Lobby').emit('roomUsers', {
                 room: 'Lobby',
                 users: getUsersInRoom('Lobby')
               });
             }
           }

           io.to(roomName).emit('roomUsers', {
             room: roomName,
             users: getUsersInRoom(roomName)
           });
           broadcastRoomsList();
         }
      );
    });
  });

  // Handle muting a user
  socket.on('muteUser', ({ roomName, targetUsername, duration }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    db.get(`SELECT creator FROM rooms WHERE name = ?`, [roomName], (err, roomRow) => {
      if (err) {
        socket.emit('moderationError', 'Database error while searching for the room.');
        return;
      }
      if (!roomRow) {
        socket.emit('moderationError', 'Room does not exist.');
        return;
      }

      if (roomRow.creator.toLowerCase() !== user.username.toLowerCase()) {
         socket.emit('moderationError', 'You do not have moderator permissions in this room.');
         return;
      }

      if (user.username.toLowerCase() === targetUsername.toLowerCase()) {
         socket.emit('moderationError', 'You cannot mute yourself.');
         return;
      }

      const rawDuration = parseInt(duration, 10) || 60;
      const clampedDuration = Math.min(Math.max(rawDuration, 1), 86400); // 1 sec to 24 hrs
      const muteDurationMs = clampedDuration * 1000;
      const mutedUntil = Date.now() + muteDurationMs;

      db.run(
         `INSERT OR REPLACE INTO room_mutes (room, username, muted_until) VALUES (?, ?, ?)`,
         [roomName, targetUsername.toLowerCase(), mutedUntil],
         (err) => {
           if (err) {
             socket.emit('moderationError', 'Failed to mute user in database.');
             return;
           }

           io.to(roomName).emit('message', {
             system: true,
             text: `${targetUsername} was muted in this room for ${clampedDuration} seconds by the creator.`
           });

           activeUsers.forEach((activeUser, sId) => {
             if (activeUser.room === roomName && activeUser.username.toLowerCase() === targetUsername.toLowerCase()) {
               io.to(sId).emit('mutedNotification', {
                 room: roomName,
                 duration: clampedDuration
               });
             }
           });
         }
      );
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Close SQLite database connection when process exits
function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed.');
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
