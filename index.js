// =========================================================================
// INDEX.JS - WA-TELEGRAM STEALTH BRIDGE (ULTIMATE V18 - CACHE & GROUP FIX)
// =========================================================================

process.on('uncaughtException', (err) => console.error('[ANTI-CRASH] Uncaught Exception:', err.message));
process.on('unhandledRejection', (err) => console.error('[ANTI-CRASH] Unhandled Rejection:', err.message));

const {
    default: makeWASocket,
    DisconnectReason,
    downloadContentFromMessage,
    initAuthCreds,
    BufferJSON,
    fetchLatestBaileysVersion,
    Browsers,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const pino = require('pino');
const NodeCache = require('node-cache');
const { MongoClient } = require('mongodb');

// =========================================================================
// KONFIGURASI LINGKUNGAN
// =========================================================================
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
    { command: 'setmedia', description: 'Atur batas maksimal unduh media (MB)' },
    { command: 'stealth', description: 'Nyalakan/Matikan Centang 1' },
    { command: 'info', description: 'Detail Kontak Topik ini' },
    { command: 'mute', description: 'Bisukan Topik' },
    { command: 'unmute', description: 'Bunyikan Topik' },
    { command: 'login', description: 'Tautkan nomor WA baru' },
    { command: 'restart', description: 'Restart server bot' }
]);

const cacheAntiSpam = new NodeCache({ stdTTL: 3600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });
const botSentCache = new NodeCache({ stdTTL: 3600 }); 
const msgMapCache = new NodeCache({ stdTTL: 86400 }); 
const statusMemory = new NodeCache({ stdTTL: 86400 }); 

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;

let dbConfig = { 
    topik: {}, 
    sysTopics: {}, 
    muted: [], 
    stealthMode: true, 
    nomorWaUtama: process.env.NOMOR_WA_UTAMA || null, 
    pinned_status_msg_id: null,
    maxMediaMB: 20,
    contacts: {},
    topicInfoMsgs: {}
};

let statusHpSaatIni = 'Menghubungkan...';
let sedangMemprosesAntrean = false;
const antreanPesan = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setTGReaction(msgId, emoji) {
    try {
        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/setMessageReaction', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
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
            } else { return null; }
        }
    } return null;
}

// =========================================================================
// MONGODB & ADAPTER SESI TERMUX
// =========================================================================
const mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
let authCollection, configCollection;

async function hubungkanDatabase() {
    await mongoClient.connect();
    const db = mongoClient.db('wa_backup_db');
    authCollection = db.collection('auth_sessions');
    configCollection = db.collection('bot_config');

    const config = await configCollection.findOne({ _id: 'global_settings' });
    if (config) {
        const loadData = config.data ? config.data : config;
        dbConfig = { ...dbConfig, ...loadData };
        if (!dbConfig.contacts) dbConfig.contacts = {};
        if (!dbConfig.topicInfoMsgs) dbConfig.topicInfoMsgs = {};
    }
    await inisialisasiTopikSistem();
    console.log('[DB] Berhasil terhubung ke MongoDB Atlas.');
}

async function simpanKonfigurasiDB() {
    try { await configCollection.updateOne({ _id: 'global_settings' }, { $set: dbConfig }, { upsert: true }); } catch (e) {}
}

async function useMongoDBAuthState() {
    let creds; 
    try {
        const doc = await authCollection.findOne({ _id: 'creds' });
        if (doc) {
            const rawData = doc.data || doc; 
            creds = JSON.parse(JSON.stringify(rawData), BufferJSON.reviver);
        }
    } catch (e) {}
    
    if (!creds) creds = initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    try {
                        await Promise.all(ids.map(async (id) => {
                            const rec = await authCollection.findOne({ _id: `${type}-${id}` });
                            if (rec) {
                                const val = rec.data || rec;
                                data[id] = JSON.parse(JSON.stringify(val), BufferJSON.reviver);
                            }
                        }));
                    } catch (e) {}
                    return data;
                },
                set: async (data) => {
                    try {
                        const tasks = [];
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id];
                                if (value) tasks.push(authCollection.updateOne({ _id: `${category}-${id}` }, { $set: { data: JSON.parse(JSON.stringify(value, BufferJSON.replacer)) } }, { upsert: true }));
                                else tasks.push(authCollection.deleteOne({ _id: `${category}-${id}` }));
                            }
                        }
                        await Promise.all(tasks);
                    } catch (e) {}
                }
            }
        },
        saveCreds: async () => { 
            try { await authCollection.updateOne({ _id: 'creds' }, { $set: { data: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)) } }, { upsert: true }); } 
            catch (e) {}
        }
    };
}

async function ambilInfoKontak(rawJid, pushNameFallback) {
    if (!rawJid) return { nama: 'Unknown', cleanJid: '', isLid: false, isGrup: false };
    const cleanJid = jidNormalizedUser(rawJid); 
    const nomor = cleanJid.split('@')[0];
    const isLid = cleanJid.includes('@lid');
    const isGrup = cleanJid.endsWith('@g.us');

    if (isGrup && !dbConfig.contacts[cleanJid] && globalSock) {
        try {
            const meta = await globalSock.groupMetadata(cleanJid);
            if (meta.subject) { dbConfig.contacts[cleanJid] = meta.subject; simpanKonfigurasiDB(); }
        } catch (e) {}
    }

    let nama = dbConfig.contacts[cleanJid] || pushNameFallback;
    if (!nama || nama === 'Kontak') { nama = isGrup ? 'Grup ' + nomor : (isLid ? 'Rahasia (LID)' : '+' + nomor); } 
    else { dbConfig.contacts[cleanJid] = nama; }
    
    return { nama, nomor, cleanJid, isLid, isGrup };
}

// =========================================================================
// UNIVERSAL MESSAGE UNWRAPPER
// =========================================================================
function extractMessageContent(msg) {
    if (!msg) return { text: '', mediaObj: null, type: '', mediaType: '', isViewOnce: false };
    let isViewOnce = false;
    let actualMsg = msg;
    
    if (actualMsg.documentWithCaptionMessage) actualMsg = actualMsg.documentWithCaptionMessage.message;
    if (actualMsg.ephemeralMessage) actualMsg = actualMsg.ephemeralMessage.message;
    if (actualMsg.ptvMessage) actualMsg = actualMsg.ptvMessage; 

    const voKeys = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    const voKey = Object.keys(actualMsg).find(k => voKeys.includes(k));
    if (voKey) {
        isViewOnce = true;
        actualMsg = actualMsg[voKey].message;
    }

    const type = Object.keys(actualMsg).find(k => !['senderKeyDistributionMessage', 'messageContextInfo'].includes(k));
    let text = '';
    let mediaObj = null;
    let mediaType = '';

    if (type === 'conversation') { text = actualMsg.conversation; }
    else if (type === 'extendedTextMessage') { text = actualMsg.extendedTextMessage?.text; }
    else if (['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'ptvMessage', 'stickerMessage'].includes(type)) {
        mediaObj = actualMsg[type];
        text = mediaObj.caption || '';
        mediaType = type.replace('Message', '');
        if (type === 'ptvMessage') mediaType = 'video';
    } 
    else if (type === 'reactionMessage') { text = actualMsg.reactionMessage?.text; } 
    else if (type === 'pollCreationMessage' || type === 'pollCreationMessageV3') {
        const poll = actualMsg[type];
        text = `📊 *Polling:* ${poll.name}\n` + (poll.options || []).map(o => `• ${o.optionName}`).join('\n');
    } 
    else if (type === 'contactMessage') { text = `👤 *Kontak:* ${actualMsg.contactMessage?.displayName || 'Unknown'}`; } 
    else if (type === 'locationMessage') { text = `📍 *Lokasi:* ${actualMsg.locationMessage?.name || 'Terlampir'}`; }

    return { actualMsg, type, text, mediaObj, mediaType, isViewOnce };
}

// =========================================================================
// TOPIK & COMMAND TELEGRAM
// =========================================================================
async function inisialisasiTopikSistem() {
    const sysNames = { audit: "🗑️ Audit Log", aktivitas: "📝 Log Aktivitas", statusWA: "📱 Status WA" };
    let updated = false;
    for (const [key, name] of Object.entries(sysNames)) {
        if (!dbConfig.sysTopics[key]) {
            const t = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, name));
            if (t) { dbConfig.sysTopics[key] = t.message_thread_id; updated = true; await delay(1500); }
        }
    } if (updated) await simpanKonfigurasiDB();
}

async function pastikanTopik(cleanJid, namaAsli, nomor) {
    if (dbConfig.topik[cleanJid]) return dbConfig.topik[cleanJid];
    
    const isGrup = cleanJid.endsWith('@g.us');
    let namaFolder = isGrup ? '👥 GRUP: ' + namaAsli : '👤 ' + namaAsli + ' (' + nomor + ')';
    namaFolder = namaFolder.substring(0, 127);
    
    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) return null; 
    dbConfig.topik[cleanJid] = result.message_thread_id;

    const infoMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, 'ℹ️ **INFO TOPIK**\nNama: ' + namaAsli + '\nNomor: ' + nomor + '\nStatus: 🔴 Offline', { message_thread_id: result.message_thread_id, parse_mode: 'Markdown' }));
    if (infoMsg) {
        dbConfig.topicInfoMsgs[cleanJid] = infoMsg.message_id;
        await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, infoMsg.message_id, { disable_notification: true }));
    }

    await simpanKonfigurasiDB();
    return result.message_thread_id;
}

async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && dbConfig.pinned_status_msg_id && antreanPesan.length === 0) return;
    statusHpSaatIni = statusBaru;
    const stealthStatus = dbConfig.stealthMode ? '🟢 AKTIF' : '🔴 MATI';
    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 Koneksi WA: *${statusBaru}*\n🛡️ Stealth Mode: ${stealthStatus}\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n📦 Antrean: ${antreanPesan.length}`;
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
    const teks = msg.text || msg.caption || '';
    const threadId = msg.message_thread_id;
    const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);
    
    const args = teks.split(' '); 
    const cmd = args[0].split('@')[0].toLowerCase(); 

    if (cmd === '/setmedia') {
        const mb = parseInt(args[1]);
        if (isNaN(mb)) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Format salah. Ketik:\n\`/setmedia 30\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        dbConfig.maxMediaMB = mb; await simpanKonfigurasiDB(); perbaruiStatusTelegram(statusHpSaatIni, true);
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Batas unduhan media diatur menjadi **${mb} MB**.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }
    if (cmd === '/info') {
        const isGroup = targetJid?.endsWith('@g.us');
        const nomor = targetJid ? targetJid.split('@')[0] : 'Tidak diketahui';
        const nama = targetJid ? (dbConfig.contacts[targetJid] || 'Tidak ada di Phonebook') : 'Unknown';
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `ℹ️ **DETAIL KONTAK**\n\nNama Phonebook: ${nama}\n📞 Nomor/JID: \`${nomor}\`\n💬 Tipe: ${isGroup ? 'Grup' : 'Pribadi'}`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }
    if (cmd === '/stealth') { dbConfig.stealthMode = !dbConfig.stealthMode; await simpanKonfigurasiDB(); perbaruiStatusTelegram(statusHpSaatIni, true); return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🛡️ Stealth Mode: ${dbConfig.stealthMode ? '🟢 ON' : '🔴 OFF'}`, { message_thread_id: threadId })); }
    if (cmd === '/status') { return tgBot.sendMessage(TG_GROUP_ID, `📊 RAM Terpakai: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB\n📦 Batas Media: ${dbConfig.maxMediaMB} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}`, { message_thread_id: threadId }); }
    if (cmd === '/mute' && targetJid) { if (!dbConfig.muted.includes(targetJid)) dbConfig.muted.push(targetJid); await simpanKonfigurasiDB(); return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔇 Topik dibisukan.`, { message_thread_id: threadId })); }
    if (cmd === '/unmute' && targetJid) { dbConfig.muted = dbConfig.muted.filter(j => j !== targetJid); await simpanKonfigurasiDB(); return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔊 Topik kembali aktif.`, { message_thread_id: threadId })); }
    if (cmd === '/login') {
        if (!args[1]) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Format: \`/login 628123456789\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        const nomor = args[1].replace(/[^0-9]/g, '');
        if (globalSock && globalSock.authState.creds.registered) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Bot sudah login.`, { message_thread_id: threadId }));
        dbConfig.nomorWaUtama = nomor; await simpanKonfigurasiDB();
        try {
            let kode = await globalSock.requestPairingCode(nomor); kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔑 *KODE PAIRING:* \`${kode}\`\nMasukkan di WA dalam 60 detik.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        } catch (e) { return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal: ${e.message}`, { message_thread_id: threadId })); }
    }
    if (cmd === '/restart') process.exit(1);

    if (targetJid && globalSock && !teks.startsWith('/')) {
        await globalSock.sendPresenceUpdate('composing', targetJid); await delay(2000); await globalSock.sendPresenceUpdate('paused', targetJid);
        let msgOptions = { text: teks };
        const hasMedia = msg.photo || msg.video || msg.document || msg.audio || msg.voice;

        try {
            if (hasMedia) {
                let fileId;
                if (msg.photo) fileId = msg.photo[msg.photo.length - 1].file_id;
                else if (msg.video) fileId = msg.video.file_id;
                else if (msg.document) fileId = msg.document.file_id;
                else if (msg.audio) fileId = msg.audio.file_id;
                else if (msg.voice) fileId = msg.voice.file_id;

                const fileUrl = await tgBot.getFileLink(fileId);
                const response = await fetch(fileUrl);
                const buffer = Buffer.from(await response.arrayBuffer());

                if (msg.photo) msgOptions = { image: buffer, caption: teks };
                else if (msg.video) msgOptions = { video: buffer, caption: teks };
                else if (msg.document) msgOptions = { document: buffer, mimetype: msg.document.mime_type || 'application/octet-stream', fileName: msg.document.file_name || 'document', caption: teks };
                else if (msg.audio || msg.voice) msgOptions = { audio: buffer, mimetype: 'audio/mp4', ptt: !!msg.voice };
            }

            const sent = await globalSock.sendMessage(targetJid, msgOptions);
            botSentCache.set(sent.key.id, true); 
            
            const tgMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⏳ [Dikirim]`, { reply_to_message_id: msg.message_id, message_thread_id: threadId }));
            if (tgMsg) {
                msgMapCache.set(sent.key.id, { tgMsgId: tgMsg.message_id, threadId: threadId });
                setTGReaction(msg.message_id, '⏳'); 
            }
        } catch (e) {}
    }
});

tgBot.on('message_reaction', async (reaction) => {
    if (reaction.new_reaction.some(r => r.emoji === '👀')) {
        const threadId = reaction.message_thread_id;
        const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);
        if (targetJid && globalSock) {
            await globalSock.sendPresenceUpdate('available', targetJid);
            await delay(1500); await globalSock.sendPresenceUpdate('unavailable', targetJid);
            safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Centang biru (Read) telah dipaksa kirim ke lawan.`, { message_thread_id: threadId }));
        }
    }
});

// =========================================================================
// SISTEM ANTREAN & PENGIRIMAN
// =========================================================================
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
        if (antreanPesan.length % 10 === 0) perbaruiStatusTelegram(statusHpSaatIni);
        await delay(500);
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function eksekusiKirimKeTelegram(infoPesan, pushName) {
    const rawJid = infoPesan.key.remoteJid;
    const cleanJid = jidNormalizedUser(rawJid); 
    const isGroup = cleanJid.endsWith('@g.us');

    if (dbConfig.muted.includes(cleanJid)) return; 

    const targetInfo = await ambilInfoKontak(cleanJid, pushName);
    let threadId = await pastikanTopik(cleanJid, targetInfo.nama, targetInfo.nomor);
    const opts = threadId ? { message_thread_id: threadId } : {}; 
    
    // PEMBUATAN NAMA PENGIRIM UNTUK GRUP
    let namaPengirimGrup = '';
    if (isGroup && infoPesan.key.participant) {
        const participantClean = jidNormalizedUser(infoPesan.key.participant);
        const partName = dbConfig.contacts[participantClean] || infoPesan.pushName || participantClean.split('@')[0];
        namaPengirimGrup = `👤 *[${partName}]*:\n`;
    }

    const { actualMsg, type, text, mediaObj, mediaType, isViewOnce } = extractMessageContent(infoPesan.message);
    if (!type) return;

    if (type === 'reactionMessage') {
        const emoji = actualMsg.reactionMessage.text;
        const sender = isGroup ? namaPengirimGrup.replace('👤 *[', '').replace(']*:\n', '') : (dbConfig.contacts[cleanJid] || pushName);
        const targetId = actualMsg.reactionMessage.key.id;
        
        const statMem = statusMemory.get(targetId);
        if (statMem) {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `[Reaksi Status: ${emoji}] dari ${sender}\n👉 _"${statMem.teks || '[Media Status]'}"_`, { message_thread_id: dbConfig.sysTopics.statusWA, parse_mode: 'Markdown' }));
            return;
        }

        const targetMsg = cacheAntiDelete.get(targetId);
        const teksAsli = targetMsg ? targetMsg.teks : 'Pesan Lama';
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `[Reaksi: ${emoji}] dari ${sender}\n👉 _"${teksAsli}"_`, { ...opts, parse_mode: 'Markdown' }));
        return;
    }

    // NOTIFIKASI SEKALI LIHAT (TIDAK DIUNDUH)
    if (isViewOnce) {
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👁️ *[PESAN SEKALI LIHAT]*\n${namaPengirimGrup}Mengirim pesan/media sekali lihat. (Silakan buka di HP)`, { ...opts, parse_mode: 'Markdown' }));
        return;
    }

    const contextInfo = actualMsg.extendedTextMessage?.contextInfo || mediaObj?.contextInfo;
    let quoteBlock = '';
    const botJid = globalSock ? jidNormalizedUser(globalSock.user.id) : '';

    if (contextInfo) {
        if (contextInfo.remoteJid === 'status@broadcast') {
            const statMem = statusMemory.get(contextInfo.stanzaId);
            const qTeks = contextInfo.quotedMessage?.conversation || contextInfo.quotedMessage?.extendedTextMessage?.text || statMem?.teks || '[Media Status]';
            quoteBlock = `> 📝 *Membalas Status:* _${qTeks}_\n\n`;
        } else if (contextInfo.quotedMessage) {
            const qContent = extractMessageContent(contextInfo.quotedMessage);
            const qTeks = qContent.text || '[Media]';
            quoteBlock = `> 📝 *Membalas:* _${qTeks}_\n\n`;
        }
    }

    const tagNotice = (contextInfo?.mentionedJid || []).includes(botJid) ? `🔔 *[ANDA DI-MENTION]*\n\n` : '';

    try {
        if (mediaObj && mediaType) {
            const ukuranBytes = parseInt(mediaObj.fileLength || 0);
            if (ukuranBytes > (dbConfig.maxMediaMB * 1024 * 1024)) {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${namaPengirimGrup}⚠️ [Media Dilewati] Ukuran melebihi batas ${dbConfig.maxMediaMB} MB.`, opts));
                return;
            }
            
            const streamMedia = await downloadContentFromMessage(mediaObj, mediaType === 'sticker' ? 'sticker' : mediaType);
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);

            if (mediaType === 'sticker') {
                await safeTG(() => tgBot.sendSticker(TG_GROUP_ID, bufferMedia, opts));
            } else {
                await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, 
                    { ...opts, caption: `${tagNotice}${namaPengirimGrup}${quoteBlock}${text}`, parse_mode: 'Markdown' },
                    { filename: `media_${infoPesan.key.id}` }
                ));
            }
        } else if (text.trim() !== '') {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${namaPengirimGrup}${quoteBlock}${text}`, { ...opts, parse_mode: 'Markdown' }));
        }
    } catch (e) {}
}

// =========================================================================
// MESIN WHATSAPP UTAMA (Baileys)
// =========================================================================
async function mulaiBotWhatsApp() {
    try {
        const { state, saveCreds } = await useMongoDBAuthState();
        
        let waVersion = [2, 3000, 1015901307];
        try {
            const { version } = await fetchLatestBaileysVersion();
            waVersion = version;
        } catch (e) {}

        const sock = makeWASocket({
            version: waVersion, 
            auth: state, 
            printQRInTerminal: false, 
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'), 
            markOnlineOnConnect: false, 
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 20000
        });
        globalSock = sock;

        const orgSendNode = sock.sendNode;
        sock.sendNode = function (node) {
            if (dbConfig.stealthMode && node.tag === 'receipt' && (node.attrs?.type === 'delivery' || node.attrs?.type === 'read')) return Promise.resolve(); 
            return orgSendNode.apply(this, arguments);
        };

        sock.ev.on('contacts.upsert', (contacts) => {
            let updated = false;
            for (const c of contacts) {
                const cleanJid = jidNormalizedUser(c.id);
                if (c.name || c.notify) { dbConfig.contacts[cleanJid] = c.name || c.notify; updated = true; }
            } if (updated) simpanKonfigurasiDB();
        });
        
        sock.ev.on('contacts.update', (contacts) => {
            let updated = false;
            for (const c of contacts) {
                const cleanJid = jidNormalizedUser(c.id);
                if (c.name || c.notify) { dbConfig.contacts[cleanJid] = c.name || c.notify; updated = true; }
            } if (updated) simpanKonfigurasiDB();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'connecting' && !sock.authState.creds.registered && !sedangMenungguPairing) {
                sedangMenungguPairing = true; 
                setTimeout(async () => {
                    if (!globalSock || sock.authState.creds.registered || sudahMemintaKode || !dbConfig.nomorWaUtama) return;
                    sudahMemintaKode = true;
                    try {
                        const clean = dbConfig.nomorWaUtama.replace(/[^0-9]/g, '');
                        let kode = await sock.requestPairingCode(clean); kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
                        await tgBot.sendMessage(TG_GROUP_ID, `⚠️ *KODE PAIRING:* \`${kode}\``, { parse_mode: 'Markdown' });
                    } catch (err) { sudahMemintaKode = false; }
                }, 3000);
            }
            if (connection === 'close') {
                globalSock = null; sedangMenungguPairing = false; sudahMemintaKode = false;
                const status = lastDisconnect?.error?.output?.statusCode;
                if (status === DisconnectReason.loggedOut || status === 401) {
                    try { await authCollection.deleteMany({}); } catch (e) {}
                    perbaruiStatusTelegram(`Logout - Perlu pairing ulang.`, true);
                } else perbaruiStatusTelegram(`Terputus (${status || '?'}), reconnecting...`, true);
                setTimeout(mulaiBotWhatsApp, 5000);
            } else if (connection === 'open') {
                sedangMenungguPairing = false; perbaruiStatusTelegram('Online (Stealth)');
                await sock.sendPresenceUpdate('unavailable');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                const cleanJid = jidNormalizedUser(call.from);
                let st = call.status === 'offer' ? 'Berdering (Masuk)' : (call.status === 'reject' ? 'Ditolak' : (call.status === 'timeout' ? 'Tidak Terjawab' : call.status));
                const nama = dbConfig.contacts[cleanJid] || cleanJid.split('@')[0];
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📞 **[PANGGILAN ${call.isVideo ? 'VIDEO' : 'SUARA'}]**\n👤 Dari: ${nama}\n📋 Status: ${st}\n🕒 ${new Date().toLocaleString('id-ID')}`, { message_thread_id: dbConfig.sysTopics.audit }));
            }
        });

        sock.ev.on('presence.update', async (presence) => {
            const cleanJid = jidNormalizedUser(presence.id);
            const state = presence.presences[Object.keys(presence.presences)[0]]?.lastKnownPresence;
            const msgId = dbConfig.topicInfoMsgs[cleanJid];
            if (msgId) {
                const nama = dbConfig.contacts[cleanJid] || 'Kontak';
                const nomor = cleanJid.split('@')[0];
                let icon = '🔴 Offline';
                if (state === 'available') icon = '🟢 Online';
                else if (state === 'composing') icon = '✍️ Mengetik...';
                else if (state === 'recording') icon = '🎤 Merekam suara...';
                safeTG(() => tgBot.editMessageText(`ℹ️ **INFO TOPIK**\nNama: ${nama}\nNomor: ${nomor}\nStatus: ${icon}`, { chat_id: TG_GROUP_ID, message_id: msgId, parse_mode: 'Markdown' }));
            }
        });

        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                if (update.update.status) {
                    const status = update.update.status;
                    const tgData = msgMapCache.get(update.key.id);
                    if (tgData) {
                        if (status === 3) setTGReaction(tgData.tgMsgId, '👍'); 
                        if (status === 4) {
                            setTGReaction(tgData.tgMsgId, '👀'); 
                            safeTG(() => tgBot.editMessageText(`👀 [Dibaca]`, { chat_id: TG_GROUP_ID, message_id: tgData.tgMsgId }));
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
            const cleanJid = jidNormalizedUser(infoPesan.key.remoteJid);
            const msgId = infoPesan.key.id;

            // 1. KUPAS PESAN & SIMPAN KE CACHE SECEPATNYA UNTUK ANTI-DELETE/EDIT
            const { actualMsg, type, text, isViewOnce } = extractMessageContent(infoPesan.message);
            const teksTersimpan = text || (actualMsg.imageMessage ? '[Foto]' : 
                                  actualMsg.videoMessage ? '[Video]' : 
                                  actualMsg.audioMessage ? '[Audio/Voice]' : 
                                  actualMsg.documentMessage ? '[Dokumen]' : 
                                  isViewOnce ? '[Pesan Sekali Lihat]' : '[Media/Pesan]');

            // Simpan langsung (Mencakup pesan orang lain & pesan dari HP sendiri)
            cacheAntiDelete.set(msgId, { teks: teksTersimpan, tipe: type });

            // Identifikasi Pengirim Asli untuk Notif Audit
            const isGroup = cleanJid.endsWith('@g.us');
            let namaSender = dbConfig.contacts[cleanJid] || pushName;
            let namaPengirimGrup = '';

            if (isGroup && infoPesan.key.participant) {
                const participantClean = jidNormalizedUser(infoPesan.key.participant);
                namaSender = dbConfig.contacts[participantClean] || infoPesan.pushName || participantClean.split('@')[0];
                namaPengirimGrup = `👤 *[${namaSender}]*:\n`;
            }
            if (infoPesan.key.fromMe) namaSender = 'Anda Sendiri';

            // 2. FITUR LOG AUDIT HAPUS & EDIT
            let isEdit = false;
            let isRevoke = false;
            let protocolMsg = null;

            if (infoPesan.message.protocolMessage) {
                protocolMsg = infoPesan.message.protocolMessage;
            } else if (infoPesan.message.editedMessage?.message?.protocolMessage) {
                protocolMsg = infoPesan.message.editedMessage.message.protocolMessage;
            }

            if (protocolMsg) {
                if (protocolMsg.type === 0 || protocolMsg.type === 'REVOKE') isRevoke = true;
                if (protocolMsg.type === 14 || protocolMsg.type === 'MESSAGE_EDIT') isEdit = true;
                
                if (isRevoke || isEdit) {
                    const idTarget = protocolMsg.key.id;
                    const dataAsli = cacheAntiDelete.get(idTarget);
                    const opts = dbConfig.topik[cleanJid] ? { message_thread_id: dbConfig.topik[cleanJid] } : {};

                    if (isRevoke) { 
                        const note = `⚠️ *[PESAN DIHAPUS]*\n👉 ${dataAsli?.teks || '(Media / Tidak tercatat)'}`;
                        safeTG(() => tgBot.sendMessage(TG_GROUP_ID, namaPengirimGrup + note, opts));
                        safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🗑️ **[AUDIT - HAPUS]**\nDari: ${namaSender}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                    } else if (isEdit) { 
                        const teksBaru = protocolMsg.editedMessage?.conversation || protocolMsg.editedMessage?.extendedTextMessage?.text || '(media)';
                        const note = `✏️ *[PESAN DIEDIT]*\n❌ *Awal:* ${dataAsli?.teks || '?'}\n✅ *Baru:* ${teksBaru}`;
                        safeTG(() => tgBot.sendMessage(TG_GROUP_ID, namaPengirimGrup + note, opts));
                        safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📝 **[AUDIT - EDIT]**\nDari: ${namaSender}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                        if (dataAsli) cacheAntiDelete.set(idTarget, { ...dataAsli, teks: teksBaru });
                    }
                    return; // Stop process, tidak perlu masuk antrean
                }
            }

            // MEDIA & STATUS WA (BROADCAST)
            if (cleanJid === 'status@broadcast') {
                const isMyOwn = infoPesan.key.fromMe;
                const senderClean = jidNormalizedUser(infoPesan.key.participant);
                const pembuat = isMyOwn ? 'ANDA SENDIRI' : (dbConfig.contacts[senderClean] || infoPesan.pushName || 'Unknown');
                
                // Simpan ID Status untuk ditanggapi
                statusMemory.set(infoPesan.key.id, { teks: text, media: !!actualMsg.imageMessage || !!actualMsg.videoMessage });

                const contextInfo = actualMsg?.extendedTextMessage?.contextInfo || actualMsg?.imageMessage?.contextInfo || actualMsg?.videoMessage?.contextInfo;
                const targetList = contextInfo?.statusJidList || contextInfo?.bcastJidList || [];
                const privasiSatu = isMyOwn ? `\n🔒 _Dibagikan ke ${targetList.length} kontak_` : '';
                
                const captionStatus = `📱 **Status: ${pembuat}**\n${text}${privasiSatu}`;
                const optsStatus = { message_thread_id: dbConfig.sysTopics.statusWA };

                if (actualMsg.imageMessage || actualMsg.videoMessage) {
                    const mType = actualMsg.imageMessage ? 'image' : 'video';
                    try {
                        const streamMedia = await downloadContentFromMessage(actualMsg[mType + 'Message'], mType);
                        let bufferMedia = Buffer.alloc(0);
                        for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);
                        await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, { ...optsStatus, caption: captionStatus, parse_mode: 'Markdown' }));
                    } catch (e) { }
                } else {
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, captionStatus, { ...optsStatus, parse_mode: 'Markdown' }));
                }

                if (isMyOwn && targetList.length > 0) {
                    await delay(1000); 
                    let viewerList = [];
                    for (const j of targetList) {
                        const info = await ambilInfoKontak(j, null);
                        viewerList.push('- ' + info.nama);
                    }
                    const chunkSize = 100; 
                    for (let i = 0; i < viewerList.length; i += chunkSize) {
                        const chunk = viewerList.slice(i, i + chunkSize).join('\n');
                        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👥 **Penerima Status**:\n\n${chunk}`, { ...optsStatus, parse_mode: 'Markdown' }));
                        await delay(500); 
                    }
                }
                return;
            }

            // 4. PESAN DARI HP SENDIRI (TETAP KIRIM KE TOPIK)
            if (infoPesan.key.fromMe) {
                if (botSentCache.has(msgId)) return; 
                try {
                    const threadId = await pastikanTopik(cleanJid, pushName, cleanJid.split('@')[0]);
                    if (threadId) {
                        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📤 (Dari HP): ${teksTersimpan}`, { message_thread_id: threadId }));
                    }
                } catch (e) {}
                return;
            }

            // 5. ANTREAN PESAN ORANG LAIN
            if (cacheAntiSpam.has(msgId)) return;
            cacheAntiSpam.set(msgId, true);

            masukAntrean(infoPesan, pushName);
        });
    } catch (err) {
        console.error('[WA INIT ERROR]', err.message);
    }
}

// =========================================================================
// STARTUP SERVER AMAN
// =========================================================================
setInterval(() => { if (global.gc) global.gc(); }, 120000);

const app = express();
app.get('/', (req, res) => res.send('Stealth Bridge Beroperasi 🚀'));

process.on('SIGTERM', async () => {
    if (globalSock) globalSock.end();
    await mongoClient.close();
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server aktif di port ${PORT}.`);
    hubungkanDatabase()
        .then(() => mulaiBotWhatsApp())
        .catch((e) => { 
            console.error('[STARTUP ERROR]', e.message); 
            process.exit(1); 
        });
});
