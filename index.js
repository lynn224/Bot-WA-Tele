// =========================================================================
// INDEX.JS - WA-TELEGRAM STEALTH BRIDGE (ULTIMATE V9 - NATIVE PROTOCOL FIX)
// Fixes: In-Memory Store Contacts, Native Media Sync, AppState Sync
// =========================================================================

process.on('uncaughtException', (err) => console.error('[ANTI-CRASH] Uncaught Exception:', err.message));
process.on('unhandledRejection', (err) => console.error('[ANTI-CRASH] Unhandled Rejection:', err));

const {
    default: makeWASocket,
    DisconnectReason,
    downloadContentFromMessage,
    initAuthCreds,
    BufferJSON,
    fetchLatestBaileysVersion,
    Browsers,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const pino = require('pino');
const NodeCache = require('node-cache');
const { MongoClient } = require('mongodb');

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
const msgMapCache = new NodeCache({ stdTTL: 86400 }); 
const statusMemory = new NodeCache({ stdTTL: 86400 }); // Ingatan Status WA (24 Jam)
const botSentCache = new NodeCache({ stdTTL: 3600 }); 

// PENGAKTIFAN MESIN KONTAK (NATIVE STORE) DENGAN PELINDUNG RAM
const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
setInterval(() => {
    store.messages = {}; // Hapus riwayat chat dari memori untuk selamatkan RAM Render
}, 10 * 60 * 1000); // Bersihkan tiap 10 Menit, sisakan hanya kontak.

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;

let dbConfig = { 
    topik: {}, sysTopics: {}, muted: [], stealthMode: true, 
    nomorWaUtama: process.env.NOMOR_WA_UTAMA || null, 
    pinned_status_msg_id: null, maxMediaMB: 20,
    contacts: {}, topicInfoMsgs: {}
};

let statusHpSaatIni = 'Menghubungkan...';
let sedangMemprosesAntrean = false;
const antreanPesan = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setTGReaction(msgId, emoji) {
    try {
        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/setMessageReaction', {
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
    if (config && config.data) {
        dbConfig = { ...dbConfig, ...config.data };
        if (!dbConfig.contacts) dbConfig.contacts = {};
        if (!dbConfig.topicInfoMsgs) dbConfig.topicInfoMsgs = {};
    }
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

// =========================================================================
// FUNGSI INTI 1: PHONEBOOK IDENTIFIER NATIVE STORE
// =========================================================================
function ambilInfoKontak(jid, pushNameFallback) {
    if (!jid) return { nama: 'Unknown', nomor: 'Unknown', isLid: false, isGrup: false };
    const nomor = jid.split('@')[0];
    const isLid = jid.includes('@lid');
    const isGrup = jid.endsWith('@g.us');
    
    // Pencarian Berlapis (Database -> Native Store -> PushName -> Fallback)
    const storeContact = store.contacts[jid];
    let nama = dbConfig.contacts[jid] || storeContact?.name || storeContact?.notify || pushNameFallback;
    
    if (!nama || nama === 'Kontak') {
        nama = isGrup ? 'Grup ' + nomor : (isLid ? 'Rahasia (LID)' : '+' + nomor);
    } else {
        dbConfig.contacts[jid] = nama; // Simpan ke cache permanen
    }
    return { nama, nomor, isLid, isGrup };
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

async function pastikanTopik(jid, pushName) {
    const info = ambilInfoKontak(jid, pushName);
    if (!dbConfig.topik[jid]) {
        let namaFolder = info.isGrup ? '👥 GRUP: ' + info.nama : '👤 ' + info.nama + ' (' + info.nomor + ')';
        namaFolder = namaFolder.substring(0, 127);
        
        const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
        if (result) {
            dbConfig.topik[jid] = result.message_thread_id;
            let displayNum = info.isLid ? 'Rahasia (LID)' : info.nomor;
            const infoMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, 'ℹ️ **INFO TOPIK**\nNama: ' + info.nama + '\nNomor: ' + displayNum + '\nStatus: 🔴 Offline', { message_thread_id: result.message_thread_id, parse_mode: 'Markdown' }));
            if (infoMsg) {
                dbConfig.topicInfoMsgs[jid] = infoMsg.message_id;
                await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, infoMsg.message_id, { disable_notification: true }));
            }
            await simpanKonfigurasiDB();
        }
    }
    return dbConfig.topik[jid];
}

// =========================================================================
// COMMAND CENTER & TELEGRAM TO WA MEDIA HANDLER (2-Way)
// =========================================================================
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
    const threadId = msg.message_thread_id;
    const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);
    
    const teks = msg.text || msg.caption || '';
    const args = teks.split(' '); 
    const cmd = args[0].split('@')[0].toLowerCase(); 

    if (cmd === '/setmedia') {
        const mb = parseInt(args[1]);
        if (isNaN(mb)) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Ketik: \`/setmedia 30\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        dbConfig.maxMediaMB = mb; await simpanKonfigurasiDB(); perbaruiStatusTelegram(statusHpSaatIni, true);
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Batas unduhan media: **${mb} MB**.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }

    if (cmd === '/info') {
        const info = ambilInfoKontak(targetJid, null);
        let ketLid = info.isLid ? '\n_*(Komunitas/Saluran WA Rahasia)*_' : '';
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `ℹ️ **DETAIL KONTAK**\n\n👤 Nama Asli/Phonebook: ${info.nama}\n📞 Nomor: \`${info.isLid ? 'LID' : '+' + info.nomor}\`\n💬 Tipe: ${info.isGrup ? 'Grup' : 'Pribadi'}\n🆔 JID: \`${targetJid || 'Belum ada'}\`${ketLid}`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }

    if (cmd === '/stealth') { dbConfig.stealthMode = !dbConfig.stealthMode; await simpanKonfigurasiDB(); perbaruiStatusTelegram(statusHpSaatIni, true); return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🛡️ Stealth Mode: ${dbConfig.stealthMode ? '🟢 ON' : '🔴 OFF'}`, { message_thread_id: threadId })); }
    if (cmd === '/status') { return tgBot.sendMessage(TG_GROUP_ID, `📊 RAM Terpakai: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB\n📦 Batas Media: ${dbConfig.maxMediaMB} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}`, { message_thread_id: threadId }); }
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

    // MENGIRIM PESAN & MEDIA DARI TELEGRAM KE WA
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
            msgMapCache.set(sent.key.id, { tgMsgId: msg.message_id, threadId: threadId });
            await setTGReaction(msg.message_id, '⏳'); // Centang 1 Awal

        } catch (e) {
            safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal mengirim: ${e.message}`, { reply_to_message_id: msg.message_id, message_thread_id: threadId }));
        }
    }
});

tgBot.on('message_reaction', async (reaction) => {
    if (reaction.new_reaction.some(r => r.emoji === '👀')) {
        const threadId = reaction.message_thread_id;
        const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);
        if (targetJid && globalSock) {
            await globalSock.sendPresenceUpdate('available', targetJid);
            await delay(1500); await globalSock.sendPresenceUpdate('unavailable', targetJid);
            safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Centang biru (Read) dipaksa kirim.`, { message_thread_id: threadId }));
        }
    }
});

// =========================================================================
// FUNGSI INTI 2: DEEP SCAN UNWRAPPER (View Once & Media Status WA)
// =========================================================================
function bukaBrankasWA(messageObj) {
    if (!messageObj) return { isViewOnce: false, actualMessage: {}, statusJidList: [] };
    let actualMessage = messageObj;
    let isViewOnce = false;

    if (actualMessage.documentWithCaptionMessage) actualMessage = actualMessage.documentWithCaptionMessage.message;
    if (actualMessage.ephemeralMessage) actualMessage = actualMessage.ephemeralMessage.message;
    if (actualMessage.ptvMessage) actualMessage = actualMessage.ptvMessage;

    const viewOnceKeys = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    let key = Object.keys(actualMessage).find(k => viewOnceKeys.includes(k));
    if (key) {
        isViewOnce = true;
        actualMessage = actualMessage[key].message;
    }

    let statusJidList = [];
    const cInfo = actualMessage?.extendedTextMessage?.contextInfo || actualMessage?.imageMessage?.contextInfo || actualMessage?.videoMessage?.contextInfo;
    if (cInfo && (cInfo.statusJidList || cInfo.bcastJidList)) {
        statusJidList = cInfo.statusJidList || cInfo.bcastJidList;
    }

    return { isViewOnce, actualMessage, statusJidList };
}

// =========================================================================
// SISTEM ANTREAN PESAN
// =========================================================================
async function masukAntrean(infoPesan, pushName = 'Kontak', isFromMe = false) {
    antreanPesan.push({ infoPesan, pushName, isFromMe });
    if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
}

async function jalankanPekerjaAntrean() {
    sedangMemprosesAntrean = true;
    while (antreanPesan.length > 0) {
        const { infoPesan, pushName, isFromMe } = antreanPesan[0];
        await eksekusiKirimKeTelegram(infoPesan, pushName, isFromMe);
        antreanPesan.shift();
        if (antreanPesan.length % 5 === 0) perbaruiStatusTelegram(statusHpSaatIni);
        await delay(500);
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function eksekusiKirimKeTelegram(infoPesan, pushName, isFromMe) {
    const idPengirim = infoPesan.key.remoteJid;
    if (dbConfig.muted.includes(idPengirim)) return; 

    let threadId = await pastikanTopik(idPengirim, pushName);
    const opts = threadId ? { message_thread_id: threadId } : {}; 
    
    // PEMBONGKARAN PESAN
    const { isViewOnce, actualMessage } = bukaBrankasWA(infoPesan.message);
    const tipePesan = Object.keys(actualMessage || {}).find(k => k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo');
    if (!tipePesan) return;

    // FUNGSI INTI 3: IDENTITAS PENGIRIM DALAM GRUP (Group Participant)
    const infoSenderRaw = ambilInfoKontak(idPengirim, pushName);
    let namaPengirimGrup = '';
    if (infoSenderRaw.isGrup && infoPesan.key.participant) {
        const partInfo = ambilInfoKontak(infoPesan.key.participant, null);
        namaPengirimGrup = `👤 *[${partInfo.nama}]*:\n`;
    }

    // PENANGANAN REAKSI EMOJI
    if (tipePesan === 'reactionMessage') {
        const emoji = actualMessage.reactionMessage.text;
        const targetId = actualMessage.reactionMessage.key.id;
        
        let senderName = isFromMe ? 'ANDA SENDIRI' : infoSenderRaw.nama;
        if (infoSenderRaw.isGrup && infoPesan.key.participant) senderName = ambilInfoKontak(infoPesan.key.participant, null).nama;

        // FUNGSI INTI 4: PELACAKAN STATUS WA (Reaksi)
        const statMem = statusMemory.get(targetId);
        if (statMem) {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `[Reaksi: ${emoji}] dari${senderName} pada Status Anda:\n👉 _"${statMem.teks || 'Media'}"_`, { message_thread_id: dbConfig.sysTopics.statusWA, parse_mode: 'Markdown' }));
            return;
        }

        const targetMsg = cacheAntiDelete.get(targetId);
        const teksAsli = targetMsg ? targetMsg.teks : 'Pesan Lama';
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `[Reaksi: ${emoji}] dari ${senderName}\n👉 _"${teksAsli}"_`, { ...opts, parse_mode: 'Markdown' }));
        return;
    }

    const teksKonten = actualMessage.conversation || actualMessage.extendedTextMessage?.text || actualMessage[tipePesan]?.caption || '';
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan });

    // QUOTED REPLY & PELACAKAN BALASAN STATUS WA
    const contextInfo = actualMessage.extendedTextMessage?.contextInfo || actualMessage.imageMessage?.contextInfo || actualMessage.videoMessage?.contextInfo || actualMessage.documentMessage?.contextInfo;
    let quoteBlock = '';
    
    const botJid = globalSock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    if (contextInfo && contextInfo.stanzaId && contextInfo.participant === botJid && contextInfo.remoteJid === 'status@broadcast') {
        const statMem = statusMemory.get(contextInfo.stanzaId);
        quoteBlock = '> 📝 *Membalas Status Anda:* _' + (contextInfo.quotedMessage?.conversation || statMem?.teks || '[Media Status]') + '_\n\n';
    } 
    else if (contextInfo && contextInfo.quotedMessage) {
        const qTeks = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || '[Media]';
        quoteBlock = '> 📝 *Membalas:* _' + qTeks + '_\n\n';
    }

    const tagNotice = (!isFromMe && (contextInfo?.mentionedJid || []).includes(botJid)) ? `🔔 *[ANDA DI-MENTION]*\n\n` : '';
    const viewOnceTag = isViewOnce ? `👁️ *[PESAN SEKALI LIHAT]*\n` : '';
    const fromMeTag = isFromMe ? `📤 *[DARI HP UTAMA]*\n` : '';

    // PENANGANAN MEDIA INSTANT DECRYPTION PADA VIEW ONCE DAN CHAT
    const pesanMedia = actualMessage.imageMessage || actualMessage.videoMessage || actualMessage.documentMessage || actualMessage.audioMessage || actualMessage.ptvMessage;

    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            if (ukuranBytes > (dbConfig.maxMediaMB * 1024 * 1024)) {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${fromMeTag}⚠️ [Media Dilewati] Ukuran melebihi ${dbConfig.maxMediaMB} MB.`, opts));
                return;
            }
            
            // Mencari format pasti media untuk dekripsi Baileys
            let tipeMediaUnduh = '';
            if (actualMessage.imageMessage) tipeMediaUnduh = 'image';
            else if (actualMessage.videoMessage || actualMessage.ptvMessage) tipeMediaUnduh = 'video';
            else if (actualMessage.documentMessage) tipeMediaUnduh = 'document';
            else if (actualMessage.audioMessage) tipeMediaUnduh = 'audio';

            const streamMedia = await downloadContentFromMessage(pesanMedia, tipeMediaUnduh);
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);

            await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, 
                { ...opts, caption: `${tagNotice}${viewOnceTag}${fromMeTag}${namaPengirimGrup}${quoteBlock}${teksKonten}`, parse_mode: 'Markdown' },
                { filename: `media_${infoPesan.key.id}` }
            ));
        } else if (teksKonten.trim() !== '') {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${viewOnceTag}${fromMeTag}${namaPengirimGrup}${quoteBlock}${teksKonten}`, { ...opts, parse_mode: 'Markdown' }));
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
    
    // Binding Mesin Native Store untuk menyerap Data Kontak WA
    store.bind(sock.ev);

    const orgSendNode = sock.sendNode;
    sock.sendNode = function (node) {
        if (dbConfig.stealthMode && node.tag === 'receipt' && (node.attrs?.type === 'delivery' || node.attrs?.type === 'read')) return Promise.resolve(); 
        return orgSendNode.apply(this, arguments);
    };

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
            const jid = call.from;
            let st = call.status === 'offer' ? 'Berdering (Masuk)' : (call.status === 'reject' ? 'Ditolak' : (call.status === 'timeout' ? 'Tidak Terjawab' : call.status));
            const info = ambilInfoKontak(jid, null);
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📞 **[PANGGILAN ${call.isVideo ? 'VIDEO' : 'SUARA'}]**\n👤 Dari: ${info.nama}\n📋 Status: ${st}\n🕒 ${new Date().toLocaleString('id-ID')}`, { message_thread_id: dbConfig.sysTopics.audit }));
        }
    });

    sock.ev.on('presence.update', async (presence) => {
        const jid = presence.id;
        const state = presence.presences[Object.keys(presence.presences)[0]]?.lastKnownPresence;
        const msgId = dbConfig.topicInfoMsgs[jid];
        if (msgId) {
            const info = ambilInfoKontak(jid, null);
            let icon = '🔴 Offline';
            if (state === 'available') icon = '🟢 Online';
            else if (state === 'composing') icon = '✍️ Mengetik...';
            else if (state === 'recording') icon = '🎤 Merekam suara...';
            safeTG(() => tgBot.editMessageText(`ℹ️ **INFO TOPIK**\nNama: ${info.nama}\nNomor: ${info.nomor}\nStatus: ${icon}`, { chat_id: TG_GROUP_ID, message_id: msgId, parse_mode: 'Markdown' }));
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            
            // FUNGSI INTI 4: PELACAKAN VIEWER STATUS WA (Read Receipt Tracker)
            if (update.key.remoteJid === 'status@broadcast' && update.update.status === 4) {
                const viewerJid = update.key.participant;
                const viewerName = ambilInfoKontak(viewerJid, null).nama;
                const statMem = statusMemory.get(update.key.id);
                safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👀 **${viewerName}** melihat status Anda:\n👉 _"${statMem?.teks || 'Media'}"_`, { message_thread_id: dbConfig.sysTopics.statusWA, parse_mode: 'Markdown' }));
                continue;
            }

            // FUNGSI INTI 5: NATIVE REACT TICK PADA TELEGRAM
            if (update.update.status) {
                const status = update.update.status;
                const tgData = msgMapCache.get(update.key.id);
                if (tgData) {
                    if (status === 3) await setTGReaction(tgData.tgMsgId, '👍'); 
                    if (status === 4) {
                        await setTGReaction(tgData.tgMsgId, '👀'); 
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

        const { isViewOnce, actualMessage, statusJidList } = bukaBrankasWA(infoPesan.message);

        // HAPUS & EDIT
        let isRevoke = false, isEdit = false, targetId = null, teksBaru = '';
        if (infoPesan.message?.protocolMessage) {
            const pt = infoPesan.message.protocolMessage;
            if (pt.type === 0 || pt.type === 'REVOKE') { isRevoke = true; targetId = pt.key.id; }
            if (pt.type === 14 || pt.type === 'MESSAGE_EDIT') { 
                isEdit = true; targetId = pt.key.id; 
                teksBaru = pt.editedMessage?.conversation || pt.editedMessage?.extendedTextMessage?.text || '(media)'; 
            }
        }
        if (infoPesan.message?.editedMessage) {
            const pt = infoPesan.message.editedMessage.message?.protocolMessage;
            if (pt) {
                isEdit = true; targetId = pt.key.id;
                teksBaru = pt.editedMessage?.conversation || pt.editedMessage?.extendedTextMessage?.text || '(media)';
            }
        }

        if (isRevoke || isEdit) {
            const dataAsli = cacheAntiDelete.get(targetId);
            const opts = dbConfig.topik[jid] ? { message_thread_id: dbConfig.topik[jid] } : {};
            const infoS = ambilInfoKontak(jid, pushName);

            if (isRevoke && targetId) { 
                const note = `⚠️ [PESAN DIHAPUS]\n👉 Isi asli: "${dataAsli?.teks || 'Media/Unknown'}"`;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🗑️ **[AUDIT - HAPUS]**\nDari: ${infoS.nama}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
            } else if (isEdit && targetId) { 
                const note = `✏️ [PESAN DIEDIT]\n👉 Sblm: "${dataAsli?.teks || '?'}"\n👉 Ssdh: "${teksBaru}"`;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📝 **[AUDIT - EDIT]**\nDari: ${infoS.nama}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                if (dataAsli) cacheAntiDelete.set(targetId, { ...dataAsli, teks: teksBaru });
            }
            return;
        }

        // FUNGSI INTI 4: MANAJEMEN STATUS WA & PRIVACY EXTRACTOR
        if (jid === 'status@broadcast') {
            const isMyOwn = infoPesan.key.fromMe;
            const pembuat = isMyOwn ? 'ANDA SENDIRI' : ambilInfoKontak(infoPesan.key.participant, infoPesan.pushName).nama;
            
            const teksKonten = actualMessage.conversation || actualMessage.extendedTextMessage?.text || '';
            const pesanMedia = actualMessage.imageMessage || actualMessage.videoMessage;
            
            // Simpan ke Cache 24 Jam agar View/Reply bisa ditarik
            statusMemory.set(infoPesan.key.id, { teks: teksKonten, media: !!pesanMedia });

            const privasiSatu = isMyOwn ? `\n🔒 _Dibagikan ke ${statusJidList.length} kontak_` : '';
            const captionStatus = `📱 **Status: ${pembuat}**\n${teksKonten}${privasiSatu}`;
            const optsStatus = { message_thread_id: dbConfig.sysTopics.statusWA };

            // Menggunakan MIME Translator untuk Dekripsi Status
            let tipeMediaUnduh = '';
            if (actualMessage.imageMessage) tipeMediaUnduh = 'image';
            else if (actualMessage.videoMessage) tipeMediaUnduh = 'video';

            if (pesanMedia && tipeMediaUnduh) {
                try {
                    const streamMedia = await downloadContentFromMessage(pesanMedia, tipeMediaUnduh);
                    let bufferMedia = Buffer.alloc(0);
                    for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);
                    await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, { ...optsStatus, caption: captionStatus, parse_mode: 'Markdown' }));
                } catch (e) { }
            } else {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, captionStatus, { ...optsStatus, parse_mode: 'Markdown' }));
            }

            // Membedah Penerima Privasi Status
            if (isMyOwn && statusJidList.length > 0) {
                await delay(1000); 
                let viewerList = statusJidList.map(j => '- ' + ambilInfoKontak(j, null).nama);
                const chunkSize = 100; 
                for (let i = 0; i < viewerList.length; i += chunkSize) {
                    const chunk = viewerList.slice(i, i + chunkSize).join('\n');
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👥 **Penerima Status Anda**:\n\n${chunk}`, { ...optsStatus, parse_mode: 'Markdown' }));
                    await delay(500); 
                }
            }
            return;
        }

        // Pesan Keluar DARI HP ke TELEGRAM (Termasuk Media)
        if (infoPesan.key.fromMe) {
            if (!msgMapCache.has(infoPesan.key.id)) {
                masukAntrean(infoPesan, pushName, true); 
            }
            return;
        }

        masukAntrean(infoPesan, pushName, false);
    });
}

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
    setTimeout(() => {
        hubungkanDatabase().then(() => mulaiBotWhatsApp()).catch(() => process.exit(1));
    }, 5000);
});
