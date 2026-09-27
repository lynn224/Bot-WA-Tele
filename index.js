// =========================================================================
// INDEX.JS - WA-TELEGRAM STEALTH BRIDGE (ULTIMATE FIX EDITION)
// Fitur: Real-time React Ticks, Phonebook Sync, Pinned Online Status, Audit Fix
// =========================================================================

process.on('uncaughtException', (err) => console.error('[ANTI-CRASH] Error:', err.message));
process.on('unhandledRejection', (err) => console.error('[ANTI-CRASH] Rejection:', err));

const {
    default: makeWASocket,
    DisconnectReason,
    downloadContentFromMessage,
    initAuthCreds,
    BufferJSON,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const pino = require('pino');
const NodeCache = require('node-cache');
const { MongoClient } = require('mongodb');
const fs = require('fs');

const TG_TOKEN = process.env.TG_TOKEN;
const TG_GROUP_ID = process.env.TG_GROUP_ID;
const MONGODB_URI = process.env.MONGODB_URI;

if (!TG_TOKEN || !TG_GROUP_ID || !MONGODB_URI) {
    console.error('[FATAL] Variabel ENV belum lengkap di Render.');
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
tgBot.on('polling_error', (err) => console.error('[TG POLLING] Gangguan:', err.message));

tgBot.setMyCommands([
    { command: 'status', description: 'Cek RAM & Koneksi' },
    { command: 'setmedia', description: 'Atur batas unduh media (MB)' },
    { command: 'stealth', description: 'Nyalakan/Matikan Centang 1' },
    { command: 'info', description: 'Detail Kontak Topik' },
    { command: 'mute', description: 'Bisukan Topik' },
    { command: 'unmute', description: 'Bunyikan Topik' },
    { command: 'login', description: 'Tautkan nomor WA baru' },
    { command: 'restart', description: 'Restart server' }
]);

const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });
const botSentCache = new NodeCache({ stdTTL: 3600 }); 
const msgMapCache = new NodeCache({ stdTTL: 86400 }); 

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;

// Config Database Utama
let dbConfig = { 
    topik: {}, 
    topicInfoMsgs: {}, // Menyimpan ID pesan pinned untuk status Online
    contacts: {},      // Menyimpan buku kontak asli
    sysTopics: {}, 
    muted: [], 
    stealthMode: true, 
    nomorWaUtama: process.env.NOMOR_WA_UTAMA || null, 
    pinned_status_msg_id: null,
    maxMediaMB: 20
};

let statusHpSaatIni = 'Menghubungkan...';
const antreanPesan = [];
let sedangMemprosesAntrean = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FUNGSI REACT TELEGRAM (Untuk Centang 1, 2, Biru)
async function setTGReaction(msgId, emoji) {
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMessageReaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_GROUP_ID, message_id: msgId, reaction: [{ type: 'emoji', emoji: emoji }] })
        });
    } catch (e) {}
}

async function safeTG(apiCall) {
    for (let i = 0; i < 3; i++) {
        try { return await apiCall(); } 
        catch (e) {
            if (e.message && e.message.includes('429')) {
                const wait = parseInt(e.message.match(/retry after (\d+)/)?.[1] || '30', 10);
                await delay((wait + 1) * 1000);
            } else if (e.message && (e.message.includes('entities') || e.message.includes('too long'))) { return null; } 
            else { return null; }
        }
    } return null;
}

const mongoClient = new MongoClient(MONGODB_URI);
let db, authCollection, configCollection;

async function hubungkanDatabase() {
    await mongoClient.connect();
    db = mongoClient.db('wa_backup_db');
    authCollection = db.collection('auth_sessions');
    configCollection = db.collection('bot_config');

    const config = await configCollection.findOne({ _id: 'global_settings' });
    if (config && config.data) dbConfig = { ...dbConfig, ...config.data };
    if (!dbConfig.topicInfoMsgs) dbConfig.topicInfoMsgs = {};
    if (!dbConfig.contacts) dbConfig.contacts = {};
    
    await inisialisasiTopikSistem();
}

async function simpanKonfigurasiDB() {
    await configCollection.updateOne({ _id: 'global_settings' }, { $set: { data: dbConfig } }, { upsert: true });
}

async function useMongoDBAuthState() {
    let creds; const doc = await authCollection.findOne({ _id: 'creds' });
    if (doc) creds = JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver); else creds = initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        const rec = await authCollection.findOne({ _id: `${type}-${id}` });
                        if (rec) data[id] = JSON.parse(JSON.stringify(rec.data), BufferJSON.reviver);
                    })); return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value) tasks.push(authCollection.updateOne({ _id: `${category}-${id}` }, { $set: { data: JSON.parse(JSON.stringify(value, BufferJSON.replacer)) } }, { upsert: true }));
                            else tasks.push(authCollection.deleteOne({ _id: `${category}-${id}` }));
                        }
                    } await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => { await authCollection.updateOne({ _id: 'creds' }, { $set: { data: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)) } }, { upsert: true }); }
    };
}

async function inisialisasiTopikSistem() {
    const sysNames = { audit: "🗑️ Audit Log", aktivitas: "📝 Log Aktivitas", statusWA: "📱 Status WA" };
    let updated = false;
    for (const [key, name] of Object.entries(sysNames)) {
        if (!dbConfig.sysTopics[key]) {
            const t = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, name));
            if (t) { dbConfig.sysTopics[key] = t.message_thread_id; updated = true; await delay(2000); }
        }
    } if (updated) await simpanKonfigurasiDB();
}

// PEMBUATAN TOPIK MENGGUNAKAN KONTAK ASLI & SYNTAX ||
async function pastikanTopik(jid, pushName) {
    if (dbConfig.topik[jid]) return dbConfig.topik[jid];
    const isGrup = jid.endsWith('@g.us');
    const nomor = jid.split('@')[0];
    
    // Menggunakan nama dari phonebook jika ada, atau pushName, atau fallback ke nomor
    const namaAsli = dbConfig.contacts[jid] || pushName || 'Kontak';
    
    // Perbaikan syntax sesuai instruksi (menggunakan penggabungan murni)
    let namaFolder = isGrup ? '👥 GRUP: ' + namaAsli : '👤 ' + namaAsli + ' (' + nomor + ')';
    namaFolder = namaFolder.substring(0, 127);
    
    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) return null; 
    
    dbConfig.topik[jid] = result.message_thread_id;
    
    // Buat Pinned Message untuk Status Online
    const infoMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `ℹ️ **INFO TOPIK**\nNama: ${namaAsli}\nNomor:${nomor}\nStatus: 🔴 Offline`, { message_thread_id: result.message_thread_id, parse_mode: 'Markdown' }));
    if (infoMsg) {
        dbConfig.topicInfoMsgs[jid] = infoMsg.message_id;
        await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, infoMsg.message_id, { disable_notification: true }));
    }
    
    await simpanKonfigurasiDB();
    return result.message_thread_id;
}

// PERBARUI STATUS ONLINE LAWAN CHAT (DI-PIN)
async function updatePresenceTopic(jid, stateText) {
    const threadId = dbConfig.topik[jid];
    const msgId = dbConfig.topicInfoMsgs[jid];
    if (threadId && msgId) {
        const nama = dbConfig.contacts[jid] || 'Kontak';
        const nomor = jid.split('@')[0];
        let icon = '🔴 Offline';
        if (stateText === 'available') icon = '🟢 Online';
        else if (stateText === 'composing') icon = '✍️ Mengetik...';
        else if (stateText === 'recording') icon = '🎤 Merekam suara...';
        
        await safeTG(() => tgBot.editMessageText(`ℹ️ **INFO TOPIK**\nNama: ${nama}\nNomor: ${nomor}\nStatus:${icon}`, { chat_id: TG_GROUP_ID, message_id: msgId, parse_mode: 'Markdown' }));
    }
}

async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && dbConfig.pinned_status_msg_id && antreanPesan.length === 0) return;
    statusHpSaatIni = statusBaru;
    const stealthStatus = dbConfig.stealthMode ? '🟢 AKTIF' : '🔴 MATI';
    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 WA: *${statusBaru}*\n🛡️ Stealth: ${stealthStatus}\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n📦 Antrean: ${antreanPesan.length}`;
    try {
        if (dbConfig.pinned_status_msg_id) { await safeTG(() => tgBot.editMessageText(teksStatus, { chat_id: TG_GROUP_ID, message_id: dbConfig.pinned_status_msg_id, parse_mode: 'Markdown' })); } 
        else {
            const msg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, teksStatus, { parse_mode: 'Markdown' }));
            if (msg) { dbConfig.pinned_status_msg_id = msg.message_id; await simpanKonfigurasiDB(); await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, dbConfig.pinned_status_msg_id, { disable_notification: true })); }
        }
    } catch (e) { dbConfig.pinned_status_msg_id = null; }
}

tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    const teks = msg.text || '';
    const threadId = msg.message_thread_id;
    const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);
    
    // Perbaikan Command Parse (Mencegah masalah klik menu /status@BotName)
    const args = teks.split(' '); 
    const cmd = args[0].split('@')[0].toLowerCase();

    if (cmd === '/setmedia') {
        const mb = parseInt(args[1]);
        if (isNaN(mb)) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Ketik: \`/setmedia 30\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        dbConfig.maxMediaMB = mb; await simpanKonfigurasiDB(); perbaruiStatusTelegram(statusHpSaatIni, true);
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Batas unduhan media diubah ke **${mb} MB**.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }
    if (cmd === '/info') {
        const nama = targetJid ? (dbConfig.contacts[targetJid] || 'Tidak ada di Phonebook') : 'Unknown';
        const nomor = targetJid ? targetJid.split('@')[0] : 'Unknown';
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `ℹ️ **DETAIL KONTAK**\nNama Asli: ${nama}\nNomor:${nomor}`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }
    if (cmd === '/stealth') { dbConfig.stealthMode = !dbConfig.stealthMode; await simpanKonfigurasiDB(); perbaruiStatusTelegram(statusHpSaatIni, true); return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🛡️ Stealth Mode: ${dbConfig.stealthMode ? '🟢 ON' : '🔴 OFF'}`, { message_thread_id: threadId })); }
    if (cmd === '/status') { return tgBot.sendMessage(TG_GROUP_ID, `📊 RAM: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB\n📦 Batas Media: ${dbConfig.maxMediaMB} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}`, { message_thread_id: threadId }); }
    if (cmd === '/mute' && targetJid) { if (!dbConfig.muted.includes(targetJid)) dbConfig.muted.push(targetJid); await simpanKonfigurasiDB(); return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔇 Topik dibisukan.`, { message_thread_id: threadId })); }
    if (cmd === '/unmute' && targetJid) { dbConfig.muted = dbConfig.muted.filter(j => j !== targetJid); await simpanKonfigurasiDB(); return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔊 Topik aktif.`, { message_thread_id: threadId })); }
    if (cmd === '/login') {
        const nomor = args[1]?.replace(/[^0-9]/g, '');
        if (!nomor) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Format: \`/login 628123456789\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        dbConfig.nomorWaUtama = nomor; await simpanKonfigurasiDB();
        try {
            let kode = await globalSock.requestPairingCode(nomor); kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔑 *KODE PAIRING:* \`${kode}\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        } catch (e) {}
    }
    if (cmd === '/restart') process.exit(1);

    // MENGIRIM PESAN
    if (targetJid && globalSock && !teks.startsWith('/')) {
        await globalSock.sendPresenceUpdate('composing', targetJid); await delay(2000); await globalSock.sendPresenceUpdate('paused', targetJid);
        
        let msgOptions = { text: teks };
        try {
            const sent = await globalSock.sendMessage(targetJid, msgOptions);
            botSentCache.set(sent.key.id, true); 
            
            // Simpan mapping untuk update React nanti
            msgMapCache.set(sent.key.id, { tgMsgId: msg.message_id, threadId: threadId });
            await setTGReaction(msg.message_id, '⏳'); // React Awal: Centang 1
            
        } catch (e) {}
    }
});

async function masukAntrean(infoPesan, pushName = 'Kontak') {
    antreanPesan.push({ infoPesan, pushName });
    if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
}

async function jalankanPekerjaAntrean() {
    sedangMemprosesAntrean = true;
    while (antreanPesan.length > 0) {
        const { infoPesan, pushName } = antreanPesan[0];
        await eksekusiKirimKeTelegram(infoPesan, pushName);
        antreanPesan.shift();
        if (antreanPesan.length % 5 === 0) perbaruiStatusTelegram(statusHpSaatIni);
        await delay(500);
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function eksekusiKirimKeTelegram(infoPesan, pushName) {
    const idPengirim = infoPesan.key.remoteJid;
    if (dbConfig.muted.includes(idPengirim)) return; 

    let threadId = await pastikanTopik(idPengirim, pushName);
    const opts = threadId ? { message_thread_id: threadId } : {}; 
    const tipePesan = Object.keys(infoPesan.message)[0];
    
    // REAKSI DARI LAWAN CHAT
    if (tipePesan === 'reactionMessage') {
        const emoji = infoPesan.message.reactionMessage.text;
        const sender = dbConfig.contacts[idPengirim] || infoPesan.pushName || idPengirim.split('@')[0];
        const targetId = infoPesan.message.reactionMessage.key.id;
        const targetMsg = cacheAntiDelete.get(targetId);
        const teksAsli = targetMsg ? targetMsg.teks : 'Pesan Lama';
        
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `[Reaksi: ${emoji}] dari ${sender}\n👉 Membalas: _"${teksAsli}"_`, { ...opts, parse_mode: 'Markdown' }));
        return;
    }

    const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan });

    const contextInfo = infoPesan.message?.extendedTextMessage?.contextInfo || infoPesan.message?.imageMessage?.contextInfo || infoPesan.message?.videoMessage?.contextInfo;
    let quoteBlock = '';
    if (contextInfo && contextInfo.quotedMessage) {
        const qTeks = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || '[Media]';
        quoteBlock = `> 📝 *Membalas:* _${qTeks}_\n\n`;
    }

    const botJid = globalSock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const tagNotice = (contextInfo?.mentionedJid || []).includes(botJid) ? `🔔 *[ANDA DI-MENTION]*\n\n` : '';

    const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage || infoPesan.message.documentMessage || infoPesan.message.audioMessage;

    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            if (ukuranBytes > (dbConfig.maxMediaMB * 1024 * 1024)) {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ [Media Dilewati] Ukuran melebihi ${dbConfig.maxMediaMB} MB.`, opts));
                return;
            }
            const streamMedia = await downloadContentFromMessage(pesanMedia, tipePesan.replace('Message', ''));
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);

            await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, 
                { ...opts, caption: `${tagNotice}${quoteBlock}${teksKonten}`, parse_mode: 'Markdown' },
                { filename: `media_${infoPesan.key.id}` }
            ));
        } else if (teksKonten.trim() !== '') {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${quoteBlock}${teksKonten}`, { ...opts, parse_mode: 'Markdown' }));
        }
    } catch (e) {}
}

// =========================================================================
// MESIN WHATSAPP UTAMA (Baileys)
// =========================================================================
async function mulaiBotWhatsApp() {
    const { state, saveCreds } = await useMongoDBAuthState();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false 
    });
    globalSock = sock;

    const orgSendNode = sock.sendNode;
    sock.sendNode = function (node) {
        if (dbConfig.stealthMode && node.tag === 'receipt' && (node.attrs?.type === 'delivery' || node.attrs?.type === 'read')) return Promise.resolve(); 
        return orgSendNode.apply(this, arguments);
    };

    async function mintaKodePairing() {
        if (!globalSock || sock.authState.creds.registered || sudahMemintaKode || !dbConfig.nomorWaUtama) return;
        sudahMemintaKode = true;
        try {
            const clean = dbConfig.nomorWaUtama.replace(/[^0-9]/g, '');
            let kode = await sock.requestPairingCode(clean);
            kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
            await tgBot.sendMessage(TG_GROUP_ID, `⚠️ *KODE PAIRING:* \`${kode}\``, { parse_mode: 'Markdown' });
        } catch (err) { sudahMemintaKode = false; }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'connecting' && !sock.authState.creds.registered && !sedangMenungguPairing) {
            sedangMenungguPairing = true; setTimeout(mintaKodePairing, 3000);
        }
        if (connection === 'close') {
            globalSock = null; sedangMenungguPairing = false; sudahMemintaKode = false;
            const status = lastDisconnect?.error?.output?.statusCode;
            if (status === DisconnectReason.loggedOut || status === 401) {
                try { await authCollection.deleteMany({}); } catch (e) {}
                perbaruiStatusTelegram(`Logout - Perlu pairing ulang.`, true);
            } else perbaruiStatusTelegram(`Terputus (${status || '?'})...`, true);
            setTimeout(mulaiBotWhatsApp, 5000);
        } else if (connection === 'open') {
            sedangMenungguPairing = false; perbaruiStatusTelegram('Online');
            await sock.sendPresenceUpdate('unavailable');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // MENGAMBIL BUKU KONTAK DARI HP (Phonebook Sync)
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            if (contact.name || contact.notify) {
                dbConfig.contacts[contact.id] = contact.name || contact.notify;
            }
        }
        simpanKonfigurasiDB();
    });

    sock.ev.on('contacts.update', (contacts) => {
        for (const contact of contacts) {
            if (contact.name || contact.notify) {
                dbConfig.contacts[contact.id] = contact.name || contact.notify;
                simpanKonfigurasiDB();
            }
        }
    });

    // MEMPERBARUI STATUS ONLINE / MENGETIK DI TOPIK TELEGRAM
    sock.ev.on('presence.update', async (presence) => {
        const jid = presence.id;
        const state = presence.presences[Object.keys(presence.presences)[0]]?.lastKnownPresence;
        await updatePresenceTopic(jid, state);
    });

    // UPDATE REACT CENTANG (DELIVERY & READ)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.status) {
                const status = update.update.status;
                const tgData = msgMapCache.get(update.key.id);
                if (tgData) {
                    if (status === 3) await setTGReaction(tgData.tgMsgId, '👍'); // Centang 2
                    if (status === 4) {
                        await setTGReaction(tgData.tgMsgId, '👀'); // Centang Biru
                        msgMapCache.del(update.key.id); 
                    }
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const infoPesan = chatUpdate.messages[0];
        if (!infoPesan || !infoPesan.message) return;

        const pushName = infoPesan.pushName || 'Kontak';
        const jid = infoPesan.key.remoteJid;
        const tipePesan = Object.keys(infoPesan.message)[0];

        // LOG AUDIT HAPUS & EDIT FIX
        if (tipePesan === 'protocolMessage') {
            const protocol = infoPesan.message.protocolMessage;
            const idTarget = protocol.key.id;
            const dataAsli = cacheAntiDelete.get(idTarget);
            const opts = dbConfig.topik[jid] ? { message_thread_id: dbConfig.topik[jid] } : {};
            const senderName = dbConfig.contacts[jid] || pushName;

            if (protocol.type === 0) { 
                const note = `⚠️ [PESAN DIHAPUS]\n👉 Isi asli: "${dataAsli?.teks || 'Media'}"`;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🗑️ **[AUDIT - HAPUS]**\nDari: ${senderName}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
            } else if (protocol.type === 14) { 
                const teksBaru = protocol.editedMessage?.conversation || protocol.editedMessage?.extendedTextMessage?.text || '(media)';
                const note = `✏️ [PESAN DIEDIT]\n👉 Sblm: "${dataAsli?.teks || '?'}"\n👉 Ssdh: "${teksBaru}"`;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📝 **[AUDIT - EDIT]**\nDari: ${senderName}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                if (dataAsli) cacheAntiDelete.set(idTarget, { ...dataAsli, teks: teksBaru });
            }
            return;
        }

        // STATUS WA
        if (jid === 'status@broadcast') {
            const isMyOwn = infoPesan.key.fromMe;
            const pembuat = isMyOwn ? 'ANDA SENDIRI' : (dbConfig.contacts[infoPesan.key.participant] || infoPesan.pushName || 'Unknown');
            const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';
            const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage;
            
            const targetList = infoPesan.message?.extendedTextMessage?.contextInfo?.statusJidList || infoPesan.message?.imageMessage?.contextInfo?.statusJidList || infoPesan.message?.videoMessage?.contextInfo?.statusJidList || [];
            
            const captionStatus = `📱 **Status: ${pembuat}**\n${teksKonten}`;
            const optsStatus = { message_thread_id: dbConfig.sysTopics.statusWA };

            if (pesanMedia) {
                try {
                    const streamMedia = await downloadContentFromMessage(pesanMedia, tipePesan.replace('Message', ''));
                    let bufferMedia = Buffer.alloc(0);
                    for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);
                    await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, { ...optsStatus, caption: captionStatus, parse_mode: 'Markdown' }));
                } catch (e) { }
            } else {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, captionStatus, { ...optsStatus, parse_mode: 'Markdown' }));
            }

            if (isMyOwn && targetList.length > 0) {
                await delay(1000); 
                let viewerList = targetList.map(j => `- ${dbConfig.contacts[j] || '+' + j.split('@')[0]}`);
                const chunkSize = 100; 
                for (let i = 0; i < viewerList.length; i += chunkSize) {
                    const chunk = viewerList.slice(i, i + chunkSize).join('\n');
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👥 **Daftar Penerima Status Anda**:\n\n${chunk}`, optsStatus));
                    await delay(500); 
                }
            }
            return;
        }

        if (infoPesan.key.fromMe) {
            if (botSentCache.has(infoPesan.key.id)) return; 
            try {
                const threadId = await pastikanTopik(jid, pushName);
                const teksKeluar = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '[Media]';
                if (threadId) {
                    const tgMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📤 (Dari HP): ${teksKeluar}`, { message_thread_id: threadId }));
                    if (tgMsg) msgMapCache.set(infoPesan.key.id, { tgMsgId: tgMsg.message_id, threadId: threadId });
                }
            } catch (e) {}
            return;
        }

        const idPesan = infoPesan.key.id;
        if (cacheAntiSpam.has(idPesan)) return;
        cacheAntiSpam.set(idPesan, true);

        masukAntrean(infoPesan, pushName);
    });
}

setInterval(() => { if (global.gc) global.gc(); }, 120000);
const app = express(); app.get('/', (req, res) => res.send('Stealth Bridge Beroperasi 🚀'));
process.on('SIGTERM', async () => { if (globalSock) globalSock.end(); await mongoClient.close(); process.exit(0); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server aktif di port ${PORT}.`);
    setTimeout(() => { hubungkanDatabase().then(() => mulaiBotWhatsApp()).catch(() => process.exit(1)); }, 5000);
});
