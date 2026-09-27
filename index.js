// =========================================================================
// INDEX.JS - WA-TELEGRAM STEALTH BRIDGE (ULTIMATE MASTER EDITION V3)
// Fitur: RAM Safety /setmedia, Status JID List Chunking, Status Radar
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
    proto
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

const HISTORY_SYNC_DELAY_MS = 15 * 60 * 1000; 
const HISTORY_BATCH_SIZE = 40; 

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
    { command: 'mute', description: 'Bisukan Topik (Jangan teruskan WA)' },
    { command: 'unmute', description: 'Bunyikan Topik' },
    { command: 'login', description: 'Tautkan nomor WA baru' },
    { command: 'restart', description: 'Restart server bot' }
]);

const cacheAntiSpam = new NodeCache({ stdTTL: 3600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });
const botSentCache = new NodeCache({ stdTTL: 3600 }); 
const msgMapCache = new NodeCache({ stdTTL: 86400 }); 

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;

// Config Database Utama
let dbConfig = { 
    topik: {}, 
    sysTopics: {}, 
    muted: [], 
    stealthMode: true, 
    nomorWaUtama: process.env.NOMOR_WA_UTAMA || null, 
    pinned_status_msg_id: null,
    maxMediaMB: 20 // Default batas media
};

let statusHpSaatIni = 'Menghubungkan...';
let sedangMemprosesAntrean = false;
let sedangSinkronisasi = false;
const antreanPesan = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// FUNGSI HELPER: Mendapatkan nama manusiawi dari JID
function ekstrakNamaDariTopik(jid) {
    if (!dbConfig.topik[jid]) return jid.split('@')[0]; // fallback ke nomor
    // Cari nama topik di Telegram API (cache nama yang kita simpan)
    // Karena kita tidak menyimpan string nama topik, kita format nomornya
    return jid.split('@')[0];
}

async function pastikanTopik(jid, pushName) {
    if (dbConfig.topik[jid]) return dbConfig.topik[jid];
    const isGrup = jid.endsWith('@g.us');
    const nomor = jid.split('@')[0];
    let namaFolder = isGrup ? `👥 GRUP: ${nomor}` : `👤 ${pushName || 'Kontak'} (${nomor})`;
    namaFolder = namaFolder.substring(0, 127);
    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) return null; 
    dbConfig.topik[jid] = result.message_thread_id;
    await simpanKonfigurasiDB();
    return result.message_thread_id;
}

async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && dbConfig.pinned_status_msg_id && antreanPesan.length === 0 && !sedangSinkronisasi) return;
    statusHpSaatIni = statusBaru;
    const stealthStatus = dbConfig.stealthMode ? '🟢 AKTIF' : '🔴 MATI';
    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 Koneksi WA: *${statusBaru}*\n🛡️ Stealth Mode: ${stealthStatus}\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n📦 Antrean: ${antreanPesan.length}`;
    if (sedangSinkronisasi) teksStatus += `\n⏳ Sinkronisasi riwayat...`;
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
    const args = teks.split(' '); const cmd = args[0].toLowerCase();

    // COMMAND: SETMEDIA (Kalkulasi Otomatis RAM)
    if (cmd === '/setmedia') {
        const mb = parseInt(args[1]);
        if (isNaN(mb)) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Format salah. Ketik:\n\`/setmedia 30\` (untuk 30 MB)`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        
        const isConfirm = args[2] === 'confirm';
        const ramTerpakai = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const ramSisa = 512 - ramTerpakai; // Render Free Tier
        
        // Peringatan jika sisa RAM terlalu mepet
        if (mb > (ramSisa * 0.4) && !isConfirm) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ **PERINGATAN KESEHATAN SERVER** ⚠️\n\nRAM Terpakai: ${ramTerpakai} MB\nSisa RAM: ~${ramSisa} MB\n\nJika Anda menetapkan batas media sebesar **${mb} MB**, server sangat berisiko mengalami *Crash* (Out of Memory) saat memproses dokumen/video besar secara bersamaan.\n\nJika Anda yakin dan ingin memaksa, ketik ulang:\n\`/setmedia ${mb} confirm\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        }

        dbConfig.maxMediaMB = mb;
        await simpanKonfigurasiDB();
        perbaruiStatusTelegram(statusHpSaatIni, true);
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Batas unduhan media berhasil diperbarui menjadi **${mb} MB**.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }

    if (cmd === '/info') {
        const isGroup = targetJid?.endsWith('@g.us');
        const nomor = targetJid ? targetJid.split('@')[0] : 'Tidak diketahui';
        const formattedNum = isGroup ? nomor : `+${nomor.slice(0,2)}${nomor.slice(2,6)}-${nomor.slice(6,10)}-${nomor.slice(10)}`;
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `ℹ️ **DETAIL KONTAK**\n\n📞 Nomor: \`${formattedNum}\`\n💬 Tipe: ${isGroup ? 'Grup' : 'Pribadi'}\nJID: \`${targetJid || 'Belum ada'}\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
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
        try {
            const sent = await globalSock.sendMessage(targetJid, msgOptions);
            botSentCache.set(sent.key.id, true); 
            const tgMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⏳ [Terkirim]`, { reply_to_message_id: msg.message_id, message_thread_id: threadId }));
            if (tgMsg) msgMapCache.set(sent.key.id, { tgMsgId: tgMsg.message_id, threadId: threadId });
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
            safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Centang biru (Read) telah dipaksa kirim.`, { message_thread_id: threadId }));
        }
    }
});

async function masukAntrean(infoPesan, isHistory = false, pushName = 'Kontak') {
    antreanPesan.push({ infoPesan, isHistory, pushName });
    if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
}

async function jalankanPekerjaAntrean() {
    sedangMemprosesAntrean = true;
    while (antreanPesan.length > 0) {
        const { infoPesan, isHistory, pushName } = antreanPesan[0];
        await eksekusiKirimKeTelegram(infoPesan, isHistory, pushName);
        antreanPesan.shift();
        if (antreanPesan.length % 10 === 0) perbaruiStatusTelegram(statusHpSaatIni);
        await delay(isHistory ? 2000 : 500);
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function eksekusiKirimKeTelegram(infoPesan, isHistory, pushName) {
    const idPengirim = infoPesan.key.remoteJid;
    if (dbConfig.muted.includes(idPengirim)) return; 

    let threadId = await pastikanTopik(idPengirim, pushName);
    const opts = threadId ? { message_thread_id: threadId } : {}; 
    const tipePesan = Object.keys(infoPesan.message)[0];
    
    // PENANGANAN REAKSI WA
    if (tipePesan === 'reactionMessage') {
        const emoji = infoPesan.message.reactionMessage.text;
        const sender = infoPesan.pushName || idPengirim.split('@')[0];
        const targetId = infoPesan.message.reactionMessage.key.id;
        const targetMsg = cacheAntiDelete.get(targetId);
        const teksAsli = targetMsg ? targetMsg.teks : 'Pesan/Media Lama';
        
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `[Reaksi: ${emoji}] dari ${sender}\n👉 Membalas: _"${teksAsli}"_`, { ...opts, parse_mode: 'Markdown' }));
        return;
    }

    const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan });

    // QUOTED REPLY
    const contextInfo = infoPesan.message?.extendedTextMessage?.contextInfo || infoPesan.message?.imageMessage?.contextInfo || infoPesan.message?.videoMessage?.contextInfo;
    let quoteBlock = '';
    if (contextInfo && contextInfo.quotedMessage) {
        const qMsg = contextInfo.quotedMessage;
        const qTeks = qMsg.conversation || qMsg.extendedTextMessage?.text || '[Media]';
        quoteBlock = `> 📝 *Membalas:* _${qTeks}_\n\n`;
    }

    // MENTION
    const mentionedJids = contextInfo?.mentionedJid || [];
    const botJid = globalSock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const tagNotice = mentionedJids.includes(botJid) ? `🔔 *[ANDA DI-MENTION]*\n\n` : '';

    const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage || infoPesan.message.documentMessage || infoPesan.message.audioMessage;
    const awalan = isHistory ? '🕰️ [Riwayat]\n' : '';

    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            if (ukuranBytes > (dbConfig.maxMediaMB * 1024 * 1024)) {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ [Media Dilewati] Ukuran melebihi batas ${dbConfig.maxMediaMB} MB. Gunakan /setmedia untuk mengubah batas.`, opts));
                return;
            }
            const streamMedia = await downloadContentFromMessage(pesanMedia, tipePesan.replace('Message', ''));
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);

            await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, 
                { ...opts, caption: `${tagNotice}${quoteBlock}${awalan}${teksKonten}`, parse_mode: 'Markdown' },
                { filename: `media_${infoPesan.key.id}` }
            ));
        } else if (teksKonten.trim() !== '') {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${quoteBlock}${awalan}${teksKonten}`, { ...opts, parse_mode: 'Markdown' }));
        }
    } catch (e) { console.error('[TG SEND ERROR]', e.message); }
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
            await tgBot.sendMessage(TG_GROUP_ID, `⚠️ *KODE PAIRING:* \`${kode}\`\nMasukkan di WA dalam 60 detik.`, { parse_mode: 'Markdown' });
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
            } else perbaruiStatusTelegram(`Terputus (${status || '?'}), reconnecting...`, true);
            setTimeout(mulaiBotWhatsApp, 5000);
        } else if (connection === 'open') {
            sedangMenungguPairing = false;
            perbaruiStatusTelegram('Online (Stealth)');
            await sock.sendPresenceUpdate('unavailable');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('presence.update', async (presence) => {
        const jid = presence.id;
        const state = presence.presences[Object.keys(presence.presences)[0]]?.lastKnownPresence;
        const threadId = dbConfig.topik[jid];
        if (threadId) {
            if (state === 'composing') safeTG(() => tgBot.sendChatAction(TG_GROUP_ID, 'typing', { message_thread_id: threadId }));
            else if (state === 'recording') safeTG(() => tgBot.sendChatAction(TG_GROUP_ID, 'record_voice', { message_thread_id: threadId }));
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            
            // RADAR STATUS WA: Mengecek laporan (Receipt) siapa yang melihat status Anda
            if (update.key.remoteJid === 'status@broadcast' && update.update.status === 4) {
                const viewerJid = update.key.participant;
                const viewerName = ekstrakNamaDariTopik(viewerJid);
                safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👀 **${viewerName}** baru saja melihat status Anda.`, { message_thread_id: dbConfig.sysTopics.statusWA, parse_mode: 'Markdown' }));
                continue;
            }

            if (update.update.status) {
                const status = update.update.status;
                const tgData = msgMapCache.get(update.key.id);
                if (tgData) {
                    let st = '';
                    if (status === 3) st = '📩 [Terkirim ke HP Lawan]';
                    if (status === 4) st = '👀 [Terbaca / Centang Biru]';
                    if (st !== '') {
                        safeTG(() => tgBot.editMessageText(st, { chat_id: TG_GROUP_ID, message_id: tgData.tgMsgId }));
                        if (status === 4) msgMapCache.del(update.key.id); 
                    }
                }
            }

            const protocol = update.update.message?.protocolMessage;
            if (protocol) {
                const idTarget = protocol.key.id;
                const jid = protocol.key.remoteJid;
                const pushName = update.key.participant ? update.key.participant.split('@')[0] : 'Kontak';
                const dataAsli = cacheAntiDelete.get(idTarget);
                const opts = dbConfig.topik[jid] ? { message_thread_id: dbConfig.topik[jid] } : {};

                if (protocol.type === 0) { 
                    const note = `⚠️ [PESAN DIHAPUS]\n👉 Isi asli: "${dataAsli?.teks || 'Media'}"`;
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🗑️ **[AUDIT - HAPUS]**\nDari: ${pushName}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                } else if (protocol.type === 14) { 
                    const teksBaru = protocol.editedMessage?.conversation || protocol.editedMessage?.extendedTextMessage?.text || '(media)';
                    const note = `✏️ [PESAN DIEDIT]\n👉 Sblm: "${dataAsli?.teks || '?'}"\n👉 Ssdh: "${teksBaru}"`;
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📝 **[AUDIT - EDIT]**\nDari: ${pushName}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                    if (dataAsli) cacheAntiDelete.set(idTarget, { ...dataAsli, teks: teksBaru });
                }
            }
        }
    });

    sock.ev.on('contacts.update', async (contacts) => {
        for (const contact of contacts) {
            if (contact.notify || contact.name) {
                const newName = contact.notify || contact.name;
                const jid = contact.id;
                const threadId = dbConfig.topik[jid];
                if (threadId) {
                     const nomor = jid.split('@')[0];
                     const isGroup = jid.endsWith('@g.us');
                     const newTopicName = isGroup ? `👥 GRUP: ${newName || nomor}` : `👤 ${newName} (${nomor})`;
                     await safeTG(() => tgBot.editForumTopic(TG_GROUP_ID, threadId, { name: newTopicName.substring(0, 127) }));
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const infoPesan = chatUpdate.messages[0];
        if (!infoPesan || !infoPesan.message) return;

        const pushName = infoPesan.pushName || 'Kontak';
        const jid = infoPesan.key.remoteJid;

        // ========================================================
        // PENANGANAN STATUS WA & DAFTAR PENERIMA PRIVASI (OPSI A)
        // ========================================================
        if (jid === 'status@broadcast') {
            const isMyOwn = infoPesan.key.fromMe;
            const pembuat = isMyOwn ? 'ANDA SENDIRI (HP UTAMA)' : (infoPesan.key.participant?.split('@')[0] || 'Unknown');
            const tipePesan = Object.keys(infoPesan.message)[0];
            const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';
            const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage;
            
            // Ekstrak statusJidList
            const targetList = infoPesan.message?.extendedTextMessage?.contextInfo?.statusJidList || infoPesan.message?.imageMessage?.contextInfo?.statusJidList || infoPesan.message?.videoMessage?.contextInfo?.statusJidList || [];
            const privasiSatu = isMyOwn ? `\n🔒 _Dibagikan ke ${targetList.length} kontak terpilih_` : '';
            
            const captionStatus = `📱 **Status: ${pembuat}**\n${teksKonten}${privasiSatu}`;
            const optsStatus = { message_thread_id: dbConfig.sysTopics.statusWA };

            // 1. Mengirim Media / Teks Status
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

            // 2. OPSI A: Mengirim Pesan Berantai Berisi Daftar JID (Batas 100 kontak per pesan)
            if (isMyOwn && targetList.length > 0) {
                await delay(1000); // Jeda sebelum mengirim daftar
                let viewerList = targetList.map(j => `- +${j.split('@')[0]}`);
                const chunkSize = 100; 
                for (let i = 0; i < viewerList.length; i += chunkSize) {
                    const chunk = viewerList.slice(i, i + chunkSize).join('\n');
                    const partLabel = viewerList.length > chunkSize ? `(Bagian ${Math.floor(i/chunkSize)+1})` : '';
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `👥 **Daftar Penerima Privasi Status Anda** ${partLabel}:\n\n${chunk}`, { ...optsStatus, parse_mode: 'Markdown' }));
                    await delay(500); 
                }
            }
            return;
        }

        if (infoPesan.key.fromMe) {
            if (botSentCache.has(infoPesan.key.id)) return; 
            try {
                const threadId = await pastikanTopik(jid, pushName);
                const teksKeluar = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '[Media/Lainnya]';
                if (threadId) {
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📤 (Dari HP): ${teksKeluar}`, { message_thread_id: threadId }));
                }
            } catch (e) {}
            return;
        }

        const idPesan = infoPesan.key.id;
        if (cacheAntiSpam.has(idPesan)) return;
        cacheAntiSpam.set(idPesan, true);

        masukAntrean(infoPesan, false, pushName);
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
