const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

const CHAT_PASSWORD = '1';
const BAN_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds
const SPAM_THRESHOLD = 5; // messages per 10 seconds
const SPAM_WINDOW = 10000; // 10 seconds

// Обновленный путь для публичных файлов
const dataPath = '/storage/emulated/0/1mfchat/';
const publicPath = path.join(dataPath, 'public');
const accountsFile = path.join(dataPath, 'accounts.json');
const messagesFile = path.join(dataPath, 'messages.json');

// Создание папок, если они не существуют
if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
}

// Инициализация JSON файлов, если их нет
if (!fs.existsSync(accountsFile)) {
    fs.writeFileSync(accountsFile, JSON.stringify([]));
}
if (!fs.existsSync(messagesFile)) {
    fs.writeFileSync(messagesFile, JSON.stringify([]));
}

// Message spam tracking
const userMessages = new Map();

// Указываем статическую папку для Express
app.use(express.static(publicPath));

function loadAccounts() {
    try {
        return JSON.parse(fs.readFileSync(accountsFile));
    } catch (error) {
        console.error('Error loading accounts:', error);
        return [];
    }
}

function saveAccounts(accounts) {
    try {
        fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving accounts:', error);
        return false;
    }
}

function loadMessages() {
    try {
        return JSON.parse(fs.readFileSync(messagesFile));
    } catch (error) {
        console.error('Error loading messages:', error);
        return [];
    }
}

function saveMessages(messages) {
    try {
        fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));
        return true;
    } catch (error) {
        console.error('Error saving messages:', error);
        return false;
    }
}

function isSpamming(userId) {
    if (!userMessages.has(userId)) {
        userMessages.set(userId, []);
    }
    
    const now = Date.now();
    const messages = userMessages.get(userId);
    
    // Удаляем старые сообщения
    const recentMessages = messages.filter(time => now - time < SPAM_WINDOW);
    userMessages.set(userId, recentMessages);
    
    return recentMessages.length >= SPAM_THRESHOLD;
}

io.on('connection', (socket) => {
    console.log('User connected');

    socket.on('login', ({ nickname, password }) => {
        if (password !== CHAT_PASSWORD) {
            socket.emit('loginError', 'Неверный пароль');
            return;
        }

        const accounts = loadAccounts();
        let account = accounts.find(a => a.nickname === nickname);
        
        if (account) {
            if (account.banned) {
                const banTimeLeft = (account.banUntil - Date.now()) / 1000 / 60;
                if (banTimeLeft > 0) {
                    socket.emit('loginError', `Вы забанены. Осталось ${Math.ceil(banTimeLeft)} минут`);
                    return;
                } else {
                    account.banned = false;
                    account.banUntil = null;
                    saveAccounts(accounts);
                }
            }
        } else {
            account = {
                nickname,
                createdAt: new Date().toISOString(),
                muted: false,
                banned: false,
                banUntil: null
            };
            accounts.push(account);
            saveAccounts(accounts);
        }
        
        socket.nickname = nickname;
        socket.emit('loginSuccess', { nickname });
        socket.emit('messages', loadMessages());
    });

    // Админ функции
    socket.on('changeNickname', ({ oldNick, newNick }) => {
        try {
            const accounts = loadAccounts();
            const account = accounts.find(a => a.nickname === oldNick);
            if (account) {
                account.nickname = newNick;
                if (saveAccounts(accounts)) {
                    io.emit('nicknameChanged', { oldNick, newNick });
                }
            }
        } catch (error) {
            console.error('Error changing nickname:', error);
        }
    });

    socket.on('muteUser', ({ nickname, muted }) => {
        try {
            const accounts = loadAccounts();
            const account = accounts.find(a => a.nickname === nickname);
            if (account) {
                account.muted = muted;
                if (saveAccounts(accounts)) {
                    io.emit('userMuted', { nickname, muted });
                }
            }
        } catch (error) {
            console.error('Error muting user:', error);
        }
    });

    socket.on('banUser', ({ nickname, banned }) => {
        try {
            const accounts = loadAccounts();
            const account = accounts.find(a => a.nickname === nickname);
            if (account) {
                account.banned = banned;
                account.banUntil = banned ? Date.now() + BAN_DURATION : null;
                if (saveAccounts(accounts)) {
                    io.emit('userBanned', { nickname, banned });
                }
            }
        } catch (error) {
            console.error('Error banning user:', error);
        }
    });

    socket.on('clearMessages', () => {
        try {
            if (saveMessages([])) {
                io.emit('messagesCleared');
            }
        } catch (error) {
            console.error('Error clearing messages:', error);
        }
    });

    socket.on('message', (messageData) => {
        if (!socket.nickname) return;
        
        const accounts = loadAccounts();
        const account = accounts.find(a => a.nickname === socket.nickname);
        
        if (!account || account.muted || account.banned) return;
        
        if (isSpamming(socket.nickname)) {
            account.banned = true;
            account.banUntil = Date.now() + BAN_DURATION;
            saveAccounts(accounts);
            socket.emit('banned', BAN_DURATION / 1000 / 60);
            return;
        }
        
        if (!userMessages.has(socket.nickname)) {
            userMessages.set(socket.nickname, []);
        }
        userMessages.get(socket.nickname).push(Date.now());
        
        const messageObj = {
            nickname: socket.nickname,
            text: messageData.text,
            important: messageData.important || false,
            timestamp: new Date().toISOString()
        };
        
        const messages = loadMessages();
        messages.push(messageObj);
        if (saveMessages(messages)) {
            io.emit('newMessage', messageObj);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});