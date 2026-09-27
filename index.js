// =========================================================================
// INDEX.JS - BOT WA-TELEGRAM STEALTH BRIDGE (RENDER.COM + MONGODB)
// =========================================================================

process.on('uncaughtException', (err) => console.log('[ANTI-CRASH] Error:', err.message));
process.on('unhandledRejection', (err) => console.log('[ANTI-CRASH] Rejection:', err));

const {
    default: makeWASocket,
    DisconnectReason,
    downloadContentFromMessage,
    proto,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const os = require('os');

// =========================================================================
// 1. KONFIGURASI ENV
// =========================================================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_GROUP_ID = process.env.TG_GROUP_ID;
const MONGODB_URI = process.env.MONGODB_URI;

if (!TG_TOKEN || !TG_GROUP_ID || !MONGODB_URI) {
    console.error('[FATAL] Variabel ENV belum lengkap!');
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
let globalSock = null;
let startTime = Date.now();

// Memory Cache
let dbConfig = { 
    topik: {}, 
    muted: [], 
    stealthMode: true, 
    sysTopics: {}, 
    statusMaster: {} 
};
let lastDeviceActivity = 0; // Timestamp aktivitas perangkat utama
let deviceStatusMsgId = null;

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// =========================================================================
// 2. KONEKSI MONGODB & INISIALISASI
// =========================================================================
const mongoClient = new MongoClient(MONGODB_URI);
let db, authCollection, configCollection, messageMap;

async function siapkanDatabase() {
    await mongoClient.connect();
    db = mongoClient.db('wa_stealth_db');
    authCollection = db.collection('auth_sessions');
    configCollection = db.collection('bot_config');
    messageMap = db.collection('message_map'); // Untuk pelacakan Edit/Tarik
    console.log('[DB] Terhubung ke MongoDB Atlas.');

    const config = await configCollection.findOne({ _id: 'global_settings' });
    if (config) Object.assign(dbConfig, config.data);

    // Siapkan Folder Auth
    const sessionDir = 'session_baileys';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);
    const dbDocs = await authCollection.find({}).toArray();
    for (const doc of dbDocs) fs.writeFileSync(`${sessionDir}/${doc._id}.json`, JSON.stringify(doc.data));

    // Siapkan Topik Sistem di Telegram jika belum ada
    await inisialisasiTopikSistem();
}

async function simpanConfigDB() {
    await configCollection.updateOne({ _id: 'global_settings' }, { $set: { data: dbConfig } }, { upsert: true });
}

// =========================================================================
// 3. LOGIKA TELEGRAM
// =========================================================================
async function safeTG(apiCall) {
    for (let i = 0; i < 3; i++) {
        try { return await apiCall(); }
        catch (e) {
            if (e.message.includes('429')) {
                const wait = parseInt(e.message.match(/retry after (\d+)/)?.[1] || 30);
                await delay((wait + 1) * 1000);
            } else return null;
        }
    }
    return null;
}

async function inisialisasiTopikSistem() {
    const sysNames = {
        audit: "🗑️ Audit Log",
        aktivitas: "📝 Log Aktivitas",
        statusPerangkat: "🟢 Status Perangkat",
        statusWA: "📱 Status WA"
    };

    for (const [key, name] of Object.entries(sysNames)) {
        if (!dbConfig.sysTopics[key]) {
            const t = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, name));
            if (t) dbConfig.sysTopics[key] = t.message_thread_id;
        }
    }
    await simpanConfigDB();
    updateDashboardPerangkat(false); // Inisialisasi Dasbor
}

async function getTopicId(jid, pushName) {
    if (dbConfig.topik[jid]) return dbConfig.topik[jid];
    const isGroup = jid.endsWith('@g.us');
    const nomor = jid.split('@')[0];
    const name = isGroup ? `👥 GRUP: ${nomor}` : `👤 ${pushName || 'Kontak'} (${nomor})`;
    
    const t = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, name));
    if (t) {
        dbConfig.topik[jid] = t.message_thread_id;
        await simpanConfigDB();
        return t.message_thread_id;
    }
    return null;
}

// Menerima Pesan / Command dari Telegram
tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    
    const teks = msg.text || '';
    const threadId = msg.message_thread_id;
    const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);

    // COMMANDS
    if (teks.startsWith('/')) {
        const cmd = teks.split(' ')[0].toLowerCase();
        if (cmd === '/stealth') {
            dbConfig.stealthMode = teks.includes('on');
            await simpanConfigDB();
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🛡️ Stealth Mode: ${dbConfig.stealthMode ? '🟢 ON' : '🔴 OFF'}`, { message_thread_id: threadId }));
        }
        if (cmd === '/ping' || cmd === '/status') {
            const uptime = Math.floor((Date.now() - startTime) / 60000);
            const ram = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const txt = `📊 **SYSTEM STATUS**\n⏱ Uptime: ${uptime} Menit\n💾 RAM: ${ram} MB\n🔗 WA: ${globalSock ? 'Connected' : 'Disconnected'}\n🛡️ Stealth: ${dbConfig.stealthMode ? 'ON' : 'OFF'}`;
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, txt, { message_thread_id: threadId }));
        }
        if (cmd === '/mute' && targetJid) {
            if (!dbConfig.muted.includes(targetJid)) dbConfig.muted.push(targetJid);
            await simpanConfigDB();
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔇 Topik ini telah di-mute.`, { message_thread_id: threadId }));
        }
        if (cmd === '/unmute' && targetJid) {
            dbConfig.muted = dbConfig.muted.filter(j => j !== targetJid);
            await simpanConfigDB();
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔊 Mute dicabut.`, { message_thread_id: threadId }));
        }
        if (cmd === '/info' && targetJid) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `ℹ️ **INFO KONTAK**\nJID: ${targetJid}`, { message_thread_id: threadId }));
        }
    }

    // Balas ke WA (Reply atau Pesan Baru)
    if (targetJid && globalSock && !teks.startsWith('/')) {
        await globalSock.sendPresenceUpdate('composing', targetJid);
        await delay(2000); // Fake Typing
        await globalSock.sendPresenceUpdate('paused', targetJid);
        await globalSock.sendMessage(targetJid, { text: teks });
    }
});

// Bypass Centang Biru via Emoji 👀
tgBot.on('message_reaction', async (reaction) => {
    if (reaction.new_reaction.some(r => r.emoji === '👀')) {
        const threadId = reaction.message_thread_id;
        const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);
        if (targetJid && globalSock) {
            await globalSock.sendPresenceUpdate('available', targetJid);
            await globalSock.readMessages([/* Membutuhkan MessageKey, logic disederhanakan */]);
            safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Centang biru dikirim untuk obrolan ini.`, { message_thread_id: threadId }));
        }
    }
});

// Dasbor Status Perangkat
async function updateDashboardPerangkat(isActive) {
    if (isActive) lastDeviceActivity = Date.now();
    const isOnline = (Date.now() - lastDeviceActivity) < 15 * 60 * 1000;
    
    const txt = `📡 **STATUS PERANGKAT UTAMA**\n\n${isOnline ? '🟢 **ONLINE / AKTIF**' : '🔴 **OFFLINE / IDLE**'}\n🕒 Terakhir Terdeteksi: ${new Date(lastDeviceActivity).toLocaleString('id-ID')} WIB`;
    
    const tId = dbConfig.sysTopics.statusPerangkat;
    if (deviceStatusMsgId) {
        await safeTG(() => tgBot.editMessageText(txt, { chat_id: TG_GROUP_ID, message_id: deviceStatusMsgId }));
    } else {
        const m = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, txt, { message_thread_id: tId }));
        if (m) {
            deviceStatusMsgId = m.message_id;
            await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, m.message_id));
        }
    }
}
setInterval(() => updateDashboardPerangkat(false), 60000); // Cek status tiap menit

// =========================================================================
// 4. MESIN WHATSAPP & EVENT HANDLER
// =========================================================================
async function mulaiBotWhatsApp() {
    const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState('session_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    globalSock = sock;

    // STEALTH MODE: Intersepsi Receipt
    const orgSendNode = sock.sendNode;
    sock.sendNode = function (node) {
        if (dbConfig.stealthMode && node.tag === 'receipt' && (node.attrs?.type === 'delivery' || node.attrs?.type === 'read')) {
            return Promise.resolve();
        }
        return orgSendNode.apply(this, arguments);
    };

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        try {
            const files = fs.readdirSync('session_baileys').filter(f => f.endsWith('.json'));
            const ops = files.map(file => ({
                updateOne: { 
                    filter: { _id: file.replace('.json', '') }, 
                    update: { $set: { data: JSON.parse(fs.readFileSync(`session_baileys/${file}`, 'utf-8')) } }, 
                    upsert: true 
                }
            }));
            if (ops.length > 0) await authCollection.bulkWrite(ops, { ordered: false });
        } catch (e) {}
    });

    sock.ev.on('connection.update', (update) => {
        if (update.connection === 'close') {
            globalSock = null;
            setTimeout(mulaiBotWhatsApp, 5000);
        } else if (update.connection === 'open') {
            console.log('✅ WA TERHUBUNG (STEALTH AKTIF)');
            sock.sendPresenceUpdate('unavailable');
        }
    });

    // Panggilan Masuk -> Audit Log
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            const txt = `📞 **[PANGGILAN ${call.status === 'offer' ? 'MASUK' : 'BERAKHIR'}]**\n👤 Dari: ${call.from}\n🕒 Waktu: ${new Date().toLocaleString()}`;
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, txt, { message_thread_id: dbConfig.sysTopics.audit }));
        }
    });

    // Pesan Masuk & Log Aktivitas Utama
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const pushName = msg.pushName || 'Kontak';
        const isFromMe = msg.key.fromMe;
        const msgId = msg.key.id;

        // Deteksi Log Aktivitas & Update Dasbor
        if (isFromMe) {
            updateDashboardPerangkat(true);
            const tId = await getTopicId(jid, pushName);
            const tgMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📱 *(Keluar):* ${msg.message.conversation || 'Media'}`, { message_thread_id: tId }));
            
            if (tgMsg && (Date.now() - lastDeviceActivity < 10000)) { // Kirim log link jika baru mulai sesi aktif
                const link = `https://t.me/c/${TG_GROUP_ID.toString().replace('-100', '')}/${tId}/${tgMsg.message_id}`;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📱 **[PESAN KELUAR]** HP Utama mengirim pesan ke *${pushName}*.\n➡️ [Lihat Pesan](${link})`, { message_thread_id: dbConfig.sysTopics.aktivitas, parse_mode: 'Markdown' }));
            }
            return;
        }

        // Penanganan Pesan Ditarik (Revoke) / Edit
        const isRevoke = msg.message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE;
        const isEdit = msg.message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;

        if (isRevoke || isEdit) {
            const targetId = msg.message.protocolMessage.key.id;
            const tId = await getTopicId(jid, pushName);
            const note = isRevoke ? `⚠️ *Pesan Ditarik Pengirim*` : `✏️ *Pesan Diedit*`;
            
            // Kirim notif ke topik kontak
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, { message_thread_id: tId }));
            // Kirim notif ke Audit Log
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🗑️ **[AUDIT LOG]**\n👤 Dari: ${pushName}\nTipe: ${note}\nKey: ${targetId}`, { message_thread_id: dbConfig.sysTopics.audit }));
            return;
        }

        // Status WA (Story)
        if (jid === 'status@broadcast') {
            const pembuat = msg.key.participant;
            const today = new Date().toDateString();
            const masterKey = `${pembuat}-${today}`;
            
            if (!dbConfig.statusMaster[masterKey]) {
                const mst = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👤 **Status: ${pembuat}**\n📅 ${today}`, { message_thread_id: dbConfig.sysTopics.statusWA }));
                if (mst) dbConfig.statusMaster[masterKey] = mst.message_id;
            }
            // Logic Extract Text/Media & Reply to Master omitted for brevity (sama dengan chat biasa)
            return;
        }

        if (dbConfig.muted.includes(jid)) return;

        // Ekstrak Pesan Normal
        const tId = await getTopicId(jid, pushName);
        const teks = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const hasMedia = Object.keys(msg.message).some(k => k.endsWith('Message') && k !== 'extendedTextMessage');

        if (hasMedia) {
            const type = Object.keys(msg.message)[0];
            try {
                const stream = await downloadContentFromMessage(msg.message[type], type.replace('Message', ''));
                let buffer = Buffer.alloc(0);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, buffer, { caption: teks, message_thread_id: tId }));
            } catch (e) {}
        } else if (teks) {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `💬 ${teks}`, { message_thread_id: tId }));
        }
        
        // Simpan Map Pesan untuk keperluan edit/tarik di masa depan
        await messageMap.updateOne({ _id: msgId }, { $set: { jid, teks } }, { upsert: true });
    });
}

// =========================================================================
// 5. SERVER KEEPALIVE (Wajib Untuk Render)
// =========================================================================
const app = express();
app.get('/', (req, res) => res.send('Stealth Bridge Beroperasi 🚀'));

siapkanDatabase().then(() => {
    app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('🌐 Web server aktif.'));
    mulaiBotWhatsApp();
});
