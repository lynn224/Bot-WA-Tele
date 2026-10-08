process.on('uncaughtException', (err) => console.error('[ANTI-CRASH] Uncaught Exception:', err.message, err.stack));
process.on('unhandledRejection', (err) => console.error('[ANTI-CRASH] Unhandled Rejection:', err));

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

// =========================================================================
// KONFIGURASI LINGKUNGAN
// =========================================================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_GROUP_ID = process.env.TG_GROUP_ID;
const MONGODB_URI = process.env.MONGODB_URI;

if (!TG_TOKEN || !TG_GROUP_ID || !MONGODB_URI) {
    console.error('[FATAL] Pastikan TG_TOKEN, TG_GROUP_ID, MONGODB_URI sudah diset di Environment Variables.');
    process.exit(1);
}

const HISTORY_SYNC_DELAY_MS = 15 * 60 * 1000;
const ZONA_WAKTU = process.env.TIMEZONE || 'Asia/Jakarta'; 

function waktuLokal(date = new Date()) {
    return date.toLocaleString('id-ID', { timeZone: ZONA_WAKTU });
}
const HISTORY_BATCH_SIZE = 40;

const tgBot = new TelegramBot(TG_TOKEN, {
    polling: { params: { allowed_updates: JSON.stringify(['message', 'message_reaction']) } }
});
tgBot.on('polling_error', (err) => console.error('[TG POLLING]', err.message));

tgBot.setMyCommands([
    { command: 'help', description: 'Daftar perintah' },
    { command: 'status', description: 'Cek RAM & koneksi' },
    { command: 'stealth', description: 'Aktif/nonaktifkan mode stealth (on/off)' },
    { command: 'setmedia', description: 'Atur batas ukuran media (MB)' },
    { command: 'info', description: 'Detail kontak topik ini' },
    { command: 'mute', description: 'Bisukan topik ini' },
    { command: 'unmute', description: 'Bunyikan topik ini' },
    { command: 'login', description: 'Tautkan/ganti nomor WA' },
    { command: 'restart', description: 'Restart server bot' }
]);

const cacheAntiSpam = new NodeCache({ stdTTL: 3600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });
const cacheDedupProtokol = new NodeCache({ stdTTL: 120 });
const statusMemory = new NodeCache({ stdTTL: 86400 });
const msgMapCache = new NodeCache({ stdTTL: 86400 });
const cacheTgMsgToWaMemori = new NodeCache({ stdTTL: 3 * 86400 });
const cacheWaMsgToTg = new NodeCache({ stdTTL: 3 * 86400 });

const withTimeout = (promise, ms, name) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timeout at ${name}`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

async function simpanPemetaanReply(tgMsgId, data) {
    cacheTgMsgToWaMemori.set(tgMsgId, data);
    try {
        await replyMapCollection.updateOne(
            { _id: tgMsgId },
            { $set: { ...data, createdAt: new Date() } },
            { upsert: true }
        );
    } catch (e) {
        console.error('[REPLY MAP SAVE ERROR]', e.message);
    }
}

async function ambilPemetaanReply(tgMsgId) {
    const dariMemori = cacheTgMsgToWaMemori.get(tgMsgId);
    if (dariMemori) return dariMemori;
    try {
        const doc = await replyMapCollection.findOne({ _id: tgMsgId });
        if (!doc) return null;
        const data = { waJid: doc.waJid, waMsg: doc.waMsg };
        cacheTgMsgToWaMemori.set(tgMsgId, data); 
        return data;
    } catch (e) {
        console.error('[REPLY MAP READ ERROR]', e.message);
        return null;
    }
}

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;
const lastSeenMap = {}; 

let dbConfig = {
    topik: {},
    kontak: {},
    sysTopics: {},
    muted: [],
    nomor_wa_utama: process.env.NOMOR_WA_UTAMA || null,
    pinned_status_msg_id: null,
    maxMediaMB: 5,
    topicInfoMsgs: {},
    kataKunci: [], 
    blacklistKataKunci: [], 
    blacklistStatus: [],
    stealthMode: true,
    lidMap: {} 
};

const currentStatusMap = {};

let statusHpSaatIni = 'Menghubungkan...';
let sedangMemprosesAntrean = false;
let sedangSinkronisasi = false;
const antreanPesan = []; 
const antreanStatus = []; 
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeTG(apiCall) {
    for (let i = 0; i < 3; i++) {
        try {
            return await apiCall();
        } catch (e) {
            if (e.message && e.message.includes('429')) {
                const wait = parseInt(e.message.match(/retry after (\d+)/)?.[1] || '30', 10);
                console.log(`[TG RATE LIMIT] Menunggu ${wait + 1} detik...`);
                await delay((wait + 1) * 1000);
            } else {
                console.error('[TG ERROR]', e.message);
                return null;
            }
        }
    }
    return null;
}

function parseVCard(vcardText) {
    if (!vcardText) return null;
    const namaMatch = vcardText.match(/FN:(.+)/);
    const nama = namaMatch ? namaMatch[1].trim() : null;
    const nomorList = [...vcardText.matchAll(/TEL[^:]*:([+()\d\s-]+)/g)].map((m) => m[1].replace(/[^\d]/g, '')).filter(Boolean);
    if (!nama && nomorList.length === 0) return null;
    return { nama, nomorList };
}

async function setTGReaksi(msgId, emoji) {
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMessageReaction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_GROUP_ID, message_id: msgId, reaction: [{ type: 'emoji', emoji }] })
        });
    } catch (e) {
        console.error('[TG REACTION ERROR]', e.message);
    }
}

function isErrorTopikBasi(pesanError) {
    if (!pesanError) return false;
    return pesanError.includes('thread not found') || pesanError.includes('TOPIC_ID_INVALID') || pesanError.includes('message thread not found');
}

async function kirimKeTopik({ jid, sysKey }, kirimFn) {
    const ambilThreadIdSaatIni = () => (sysKey ? dbConfig.sysTopics[sysKey] : dbConfig.topik[jid]);
    const threadId = ambilThreadIdSaatIni();

    try {
        return await kirimFn(threadId);
    } catch (e) {
        if (!isErrorTopikBasi(e.message)) {
            console.error('[TG ERROR]', e.message);
            return null;
        }
        console.log(`[TOPIK STALE] Thread ${threadId} tidak valid lagi (${sysKey || jid}), membuat ulang...`);

        try {
            if (sysKey) {
                delete dbConfig.sysTopics[sysKey];
                await simpanKonfigurasiDB();
                await inisialisasiTopikSistem();
            } else {
                delete dbConfig.topik[jid];
                delete dbConfig.topicInfoMsgs[jid];
                await simpanKonfigurasiDB();
                await pastikanTopik(jid);
            }
        } catch (e2) {
            console.error('[TOPIK RECREATE GAGAL]', e2.message);
            return null;
        }

        const threadIdBaru = ambilThreadIdSaatIni();
        if (!threadIdBaru) return null;

        try {
            return await kirimFn(threadIdBaru);
        } catch (e3) {
            console.error('[TOPIK RETRY GAGAL]', e3.message);
            return null;
        }
    }
}

// =========================================================================
// MONGODB
// =========================================================================
const mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
let authCollection, configCollection, replyMapCollection;

async function hubungkanDatabase() {
    await mongoClient.connect();
    const db = mongoClient.db('wa_backup_db');
    authCollection = db.collection('auth_sessions');
    configCollection = db.collection('bot_config');
    replyMapCollection = db.collection('reply_map');
    console.log('[DB] Terhubung ke MongoDB Atlas.');

    await replyMapCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3 * 86400 }).catch((e) => {
        console.error('[DB INDEX ERROR]', e.message);
    });

    const config = await configCollection.findOne({ _id: 'global_settings' });
    if (config) {
        dbConfig = { ...dbConfig, ...config };
        if (!dbConfig.lidMap) dbConfig.lidMap = {};
        delete dbConfig._id;
    }
    await inisialisasiTopikSistem();
}

async function simpanKonfigurasiDB() {
    try {
        await configCollection.updateOne({ _id: 'global_settings' }, { $set: dbConfig }, { upsert: true });
    } catch (e) {
        console.error('[DB SAVE ERROR]', e.message);
    }
}

async function useMongoDBAuthState() {
    let creds;
    const doc = await authCollection.findOne({ _id: 'creds' });
    if (doc) creds = JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
    else creds = initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        const rec = await authCollection.findOne({ _id: `${type}-${id}` });
                        if (rec) data[id] = JSON.parse(JSON.stringify(rec.data), BufferJSON.reviver);
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const _id = `${category}-${id}`;
                            if (value) tasks.push(authCollection.updateOne({ _id }, { $set: { data: JSON.parse(JSON.stringify(value, BufferJSON.replacer)) } }, { upsert: true }));
                            else tasks.push(authCollection.deleteOne({ _id }));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await authCollection.updateOne({ _id: 'creds' }, { $set: { data: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)) } }, { upsert: true });
        }
    };
}

// =========================================================================
// INFO KONTAK & MAPPING LID
// =========================================================================
function ambilInfoKontak(jid, pushNameFallback) {
    if (!jid) return { nama: 'Unknown', nomor: 'Unknown', isLid: false, isGrup: false };
    
    const isLid = jid.includes('@lid');
    const isGrup = jid.endsWith('@g.us');

    let targetPnJid = jid;
    if (isLid && dbConfig.lidMap[jid]) {
        targetPnJid = dbConfig.lidMap[jid];
    }

    const nomorAsli = targetPnJid.split('@')[0];
    let nama = dbConfig.kontak[targetPnJid] || dbConfig.kontak[jid] || pushNameFallback;

    if (!nama) {
        nama = isGrup ? ('Grup ' + nomorAsli) : (isLid && targetPnJid === jid ? 'Kontak Pribadi (LID)' : ('+' + nomorAsli));
    } else {
        dbConfig.kontak[targetPnJid] = nama;
        if (isLid) dbConfig.kontak[jid] = nama;
    }

    return { 
        nama, 
        nomor: (targetPnJid === jid && isLid) ? 'Disembunyikan (LID)' : nomorAsli, 
        isLid, 
        isGrup,
        pnJid: targetPnJid
    };
}

async function prosesProtokolPesan(protoMsg, jidPelaku) {
    if (!protoMsg?.key?.id) return;
    const idTarget = protoMsg.key.id;
    const jidChat = protoMsg.key.remoteJid;
    const isHapus = protoMsg.type === 0 || protoMsg.type === 'REVOKE';
    const isEdit = protoMsg.type === 14 || protoMsg.type === 'MESSAGE_EDIT';
    if (!isHapus && !isEdit) return;

    const dedupKey = `${isHapus ? 'hapus' : 'edit'}-${idTarget}`;
    if (cacheDedupProtokol.has(dedupKey)) return; 
    cacheDedupProtokol.set(dedupKey, true);

    if (!dbConfig.topik[jidChat]) return; 

    const dataAsli = cacheAntiDelete.get(idTarget);
    const namaPengirim = dataAsli?.pengirim || (jidPelaku ? ambilInfoKontak(jidPelaku, null).nama : ambilInfoKontak(jidChat, null).nama);

    const tgMsgIdAsli = cacheWaMsgToTg.get(idTarget) || msgMapCache.get(idTarget)?.tgMsgId;
    const threadIdChat = dbConfig.topik[jidChat];
    const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');
    const linkAsli = (tgMsgIdAsli && threadIdChat) ? `\n🔗 [Lihat pesan asli](https://t.me/c/${groupIdBersih}/${threadIdChat}/${tgMsgIdAsli})` : '';

    let note;
    if (isHapus) {
        // [TYPO FIX] Mengganti \vert{}\vert{} menjadi ||
        note = `🗑️ *Pesan Dihapus*\n👤 Dari: ${namaPengirim}\n💬 Isi pesan: "${dataAsli?.teks || '(media, isi tidak tercatat)'}"${linkAsli}`;
    } else {
        const teksBaru = protoMsg.editedMessage?.conversation || protoMsg.editedMessage?.extendedTextMessage?.text || '(media/tidak terbaca)';
        note = `✏️ *Pesan Diedit*\n👤 Dari: ${namaPengirim}\n📝 Sebelum: "${dataAsli?.teks || '(tidak tercatat)'}"\n📝 Sesudah: "${teksBaru}"${linkAsli}`;
        if (dataAsli) cacheAntiDelete.set(idTarget, { ...dataAsli, teks: teksBaru });
    }

    await kirimKeTopik({ jid: jidChat }, (tId) => tgBot.sendMessage(TG_GROUP_ID, note, { message_thread_id: tId, parse_mode: 'Markdown' }));
    await kirimKeTopik({ sysKey: 'audit' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, note, { message_thread_id: tId, parse_mode: 'Markdown' }));
}

// =========================================================================
// TOPIK TELEGRAM
// =========================================================================
async function inisialisasiTopikSistem() {
    const sysNames = {
        audit: '🗑️ Audit Log',
        aktivitas: '📝 Log Aktivitas',
        statusWA: '📱 Status WA',
        perintah: '📌 Perintah Bot',
        kataKunci: '🔔 Kata Kunci'
    };
    let updated = false;
    for (const [key, name] of Object.entries(sysNames)) {
        if (!dbConfig.sysTopics[key]) {
            const t = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, name));
            if (t) { dbConfig.sysTopics[key] = t.message_thread_id; updated = true; await delay(1500); }
        }
    }
    if (updated) await simpanKonfigurasiDB();
}

async function pastikanTopik(jid, pushName) {
    if (dbConfig.topik[jid]) return dbConfig.topik[jid];

    const isGrup = jid.endsWith('@g.us');
    
    // [REVISI] Ekstraksi Paksa LID dari metadata grup untuk semua member grup
    if (isGrup && globalSock) {
        try {
            const meta = await globalSock.groupMetadata(jid);
            if (meta?.subject) dbConfig.kontak[jid] = meta.subject;
            
            if (meta?.participants) {
                let changed = false;
                for (const p of meta.participants) {
                    if (p.lid && p.id && !dbConfig.lidMap[p.lid]) {
                        dbConfig.lidMap[p.lid] = p.id;
                        changed = true;
                        
                        // Cek apakah LID ini punya folder terpisah, jika ya, segera update namanya
                        if (dbConfig.topik[p.lid]) {
                            await renameTopikJikaPerlu(p.lid, dbConfig.kontak[p.lid] || dbConfig.kontak[p.id] || p.id.split('@')[0], false);
                        }
                    }
                }
                if (changed) await simpanKonfigurasiDB();
            }
        } catch (e) {
            console.log(`[GROUP METADATA] Gagal ambil meta grup ${jid}:`, e.message);
        }
    }

    const info = ambilInfoKontak(jid, pushName);
    
    let namaFolder = info.isGrup ? '👥 GRUP: ' + info.nama : '👤 ' + info.nama;
    if (info.nomor !== 'Disembunyikan (LID)' && !info.isGrup) {
        namaFolder += ' (' + info.nomor + ')';
    }
    namaFolder = namaFolder.substring(0, 127);

    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) throw new Error('Gagal membuat topik setelah retry');

    dbConfig.topik[jid] = result.message_thread_id;

    if (!info.isGrup) {
        const displayNum = info.nomor === 'Disembunyikan (LID)' ? 'Nomor Disembunyikan (LID)' : `+${info.nomor}`;
        const infoMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID,
            `ℹ️ *INFO KONTAK*\nNama: ${info.nama}\nNomor: ${displayNum}\nStatus: 🔴 Offline`,
            { message_thread_id: result.message_thread_id, parse_mode: 'Markdown' }));
        if (infoMsg) {
            dbConfig.topicInfoMsgs[jid] = infoMsg.message_id;
            await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, infoMsg.message_id, { disable_notification: true }));
        }
    }

    await simpanKonfigurasiDB();
    return dbConfig.topik[jid];
}

async function renameTopikJikaPerlu(jid, namaBaru, isGrup) {
    if (!namaBaru) return;
    dbConfig.kontak[jid] = namaBaru;
    
    // Sengaja dihilangkan pengecekan if(namaLama === namaBaru) return; 
    // agar topik bisa mengganti judul jika nomor asli LID-nya baru ditemukan
    await simpanKonfigurasiDB();

    const threadId = dbConfig.topik[jid];
    if (!threadId) return;

    let namaTopikBaru = isGrup ? '👥 GRUP: ' + namaBaru : '👤 ' + namaBaru;
    const info = ambilInfoKontak(jid, null);
    if (info.nomor !== 'Disembunyikan (LID)' && !isGrup) {
        namaTopikBaru += ' (' + info.nomor + ')';
    }

    try {
        await tgBot.editForumTopic(TG_GROUP_ID, threadId, { name: namaTopikBaru.substring(0, 127) });
    } catch (e) {
        // Abaikan jika Telegram menolak mengubah karena nama sudah sama persis
    }
}

// =========================================================================
// STATUS COMMAND CENTER
// =========================================================================
async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && dbConfig.pinned_status_msg_id && antreanPesan.length === 0 && antreanStatus.length === 0 && !sedangSinkronisasi) return;
    statusHpSaatIni = statusBaru;

    const statusStealth = dbConfig.stealthMode ? '🟢 AKTIF (Hantu)' : '🔴 NONAKTIF';
    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 Koneksi WA: *${statusBaru}*\n🕶️ Mode Stealth: *${statusStealth}*\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n📦 Antrean: ${antreanPesan.length} pesan +${antreanStatus.length} story`;
    if (sedangSinkronisasi) teksStatus += `\n⏳ Sinkronisasi riwayat berjalan...`;

    try {
        if (dbConfig.pinned_status_msg_id) {
            const editRes = await safeTG(() => tgBot.editMessageText(teksStatus, { chat_id: TG_GROUP_ID, message_id: dbConfig.pinned_status_msg_id, parse_mode: 'Markdown' }));
            if (!editRes) {
                dbConfig.pinned_status_msg_id = null; 
                await simpanKonfigurasiDB();
            }
        } 
        
        if (!dbConfig.pinned_status_msg_id) {
            const msg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, teksStatus, { parse_mode: 'Markdown' }));
            if (msg) {
                dbConfig.pinned_status_msg_id = msg.message_id;
                await simpanKonfigurasiDB();
                await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, msg.message_id, { disable_notification: true }));
            }
        }
    } catch (e) {
        dbConfig.pinned_status_msg_id = null;
    }
}

// =========================================================================
// COMMAND TELEGRAM
// =========================================================================
const DURASI_AUTO_HAPUS_PERINTAH = 5 * 60 * 1000;

tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    const threadId = msg.message_thread_id;
    const targetJid = Object.keys(dbConfig.topik).find((k) => dbConfig.topik[k] === threadId);
    const teks = msg.text || msg.caption || '';
    const args = teks.split(' ');
    const cmd = args[0].split('@')[0].toLowerCase();

    const jadwalkanHapusPerintah = (idBalasan) => {
        if (!cmd.startsWith('/')) return; 
        setTimeout(async () => {
            try { await tgBot.deleteMessage(TG_GROUP_ID, msg.message_id); } catch (e) { console.log('[INFO] Hapus pesan command diabaikan karena Bot bukan Admin.'); }
            if (idBalasan) { try { await tgBot.deleteMessage(TG_GROUP_ID, idBalasan); } catch (e) {} }
        }, DURASI_AUTO_HAPUS_PERINTAH);
    };
    
    const balasPerintah = async (teksBalasan, opts = {}) => {
        const hasil = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, teksBalasan, { message_thread_id: threadId, ...opts }));
        jadwalkanHapusPerintah(hasil?.message_id);
        return hasil;
    };

    if (cmd === '/help') {
        const help = `🛠️ *MENU COMMAND*\n\n*Umum* (jalankan di topik 📌 Perintah Bot):\n/status - Diagnostik server\n/stealth [on/off] - Mode hantu (tanpa online & centang biru)\n/setmedia [MB] - Atur batas ukuran media\n/online - Status online semua kontak tersimpan\n/restart - Restart bot\n/login [nomor] - Tautkan/ganti nomor WA\n\n*Kata Kunci* (notifikasi di topik 🔔 Kata Kunci):\n/addkata kata1,kata2 - Tambah kata kunci\n/listkata - Lihat daftar kata kunci\n/delkata [nomor] - Hapus kata kunci\n/blacklistkata - Blacklist kontak ini dari notif kata kunci\n/unblacklistkata - Cabut blacklist kata kunci\n/listblacklistkata - Lihat daftar blacklist kata kunci\n\n*Status WA*:\n/nostatus - Jangan unduh status kontak ini (jalankan di topiknya)\n/yesstatus - Cabut, unduh lagi\n/liststatus - Lihat daftar blacklist status\n\n*Khusus topik kontak/grup*:\n/info - Detail lengkap kontak (foto, bio, status online)\n/mute /unmute - Bisukan/aktifkan topik ini\n/hapustopik - Hapus topik ini + data terkaitnya\n\n*Lainnya*:\n/hapussemuatopik konfirmasi - Hapus SEMUA topik kontak/grup (data penting tetap aman)\n\n💬 Ketik langsung di topik untuk kirim pesan baru. Pakai fitur *Reply* Telegram untuk membalas pesan WA tertentu.`;
        return balasPerintah(help, { parse_mode: 'Markdown' });
    }

    if (cmd === '/stealth') {
        const arg = (args[1] || '').toLowerCase();
        if (arg === 'on') {
            dbConfig.stealthMode = true;
            if (globalSock) {
                try { await globalSock.sendPresenceUpdate('unavailable'); } catch (e) {}
            }
        } else if (arg === 'off') {
            dbConfig.stealthMode = false;
        } else {
            return balasPerintah(`⚠️ Format: \`/stealth on\` atau \`/stealth off\`\nStatus sekarang: *${dbConfig.stealthMode ? 'AKTIF' : 'NONAKTIF'}*`, { parse_mode: 'Markdown' });
        }
        await simpanKonfigurasiDB();
        perbaruiStatusTelegram(statusHpSaatIni, true);
        return balasPerintah(`✅ Mode Stealth berhasil diubah menjadi: *${dbConfig.stealthMode ? 'AKTIF' : 'NONAKTIF'}*`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/setmedia') {
        const mb = parseInt(args[1]);
        if (isNaN(mb) || mb <= 0) return balasPerintah(`⚠️ Ketik: \`/setmedia 10\``, { parse_mode: 'Markdown' });
        dbConfig.maxMediaMB = mb;
        await simpanKonfigurasiDB();
        perbaruiStatusTelegram(statusHpSaatIni, true);
        return balasPerintah(`✅ Batas media: *${mb} MB*`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/info') {
        if (!targetJid) return balasPerintah(`⚠️ Jalankan di dalam topik kontak.`);
        const info = ambilInfoKontak(targetJid, null);
        const ketLid = info.nomor === 'Disembunyikan (LID)' ? '\n_(Komunitas/Saluran WA — nomor asli disembunyikan WhatsApp)_' : '';
        const statusOnline = currentStatusMap[targetJid] || '❔ Belum diketahui';
        const terakhirTerlihat = (statusOnline === '🔴 Offline' && lastSeenMap[targetJid])
            ? `\n🕒 Terakhir terlihat: ${waktuLokal(new Date(lastSeenMap[targetJid]))}` : '';

        let bio = '';
        if (!info.isGrup && globalSock) {
            try {
                const targetBio = info.pnJid || targetJid;
                const st = await globalSock.fetchStatus(targetBio);
                if (st?.status) bio = `\n📝 Bio: ${st.status}`;
            } catch (e) { }
        }

        const teksInfo = `ℹ️ *DETAIL KONTAK*\n\n👤 Nama: ${info.nama}\n📞 Nomor: \`${info.nomor !== 'Disembunyikan (LID)' ? '+' + info.nomor : 'LID'}\`\n💬 Tipe: ${info.isGrup ? 'Grup' : 'Pribadi'}\n🟢 Status: ${statusOnline}${terakhirTerlihat}${bio}\n🆔 JID: \`${info.pnJid || targetJid}\`${ketLid}`;

        let fotoUrl = null;
        if (globalSock) {
            try { 
                const targetPic = info.pnJid || targetJid;
                fotoUrl = await globalSock.profilePictureUrl(targetPic, 'image'); 
            } catch (e) { }
        }

        let hasil;
        if (fotoUrl) {
            hasil = await safeTG(() => tgBot.sendPhoto(TG_GROUP_ID, fotoUrl, { caption: teksInfo, message_thread_id: threadId, parse_mode: 'Markdown' }));
        } else {
            hasil = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${teksInfo}\n\n_(Tidak ada foto profil / diprivasi)_`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        }
        jadwalkanHapusPerintah(hasil?.message_id);
        return hasil;
    }

    if (cmd === '/status') {
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        return balasPerintah(`📊 RAM: ${ram} MB\n🕶️ Stealth: ${dbConfig.stealthMode ? 'Aktif' : 'Nonaktif'}\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}\n📦 Antrean: ${antreanPesan.length} pesan +${antreanStatus.length} story`);
    }

    if (cmd === '/online') {
        const daftarJid = Object.keys(dbConfig.topik).filter((j) => !j.endsWith('@g.us'));
        if (daftarJid.length === 0) return balasPerintah(`Belum ada kontak tersimpan.`);

        const baris = daftarJid.map((j) => {
            const nama = ambilInfoKontak(j, null).nama;
            const st = currentStatusMap[j] || '❔ Belum diketahui';
            // [TYPO FIX] Mengganti \vert{}\vert{} menjadi ||
            return `${st === '🟢 Online' ? '🟢' : st.includes('Mengetik') || st.includes('Merekam') ? '🟡' : '🔴'} ${nama}`;
        });
        return balasPerintah(`📶 *STATUS ONLINE KONTAK*\n\n${baris.join('\n')}`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/mute' && targetJid) {
        if (!dbConfig.muted.includes(targetJid)) dbConfig.muted.push(targetJid);
        await simpanKonfigurasiDB();
        return balasPerintah(`🔇 Topik dibisukan.`);
    }
    if (cmd === '/unmute' && targetJid) {
        dbConfig.muted = dbConfig.muted.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB();
        return balasPerintah(`🔊 Topik aktif.`);
    }

    if (cmd === '/hapustopik' && targetJid) {
        const threadIdLama = dbConfig.topik[targetJid];
        try { await tgBot.deleteForumTopic(TG_GROUP_ID, threadIdLama); } catch (e) {}

        delete dbConfig.topik[targetJid];
        delete dbConfig.topicInfoMsgs[targetJid];
        dbConfig.muted = dbConfig.muted.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB();
        try { await replyMapCollection.deleteMany({ waJid: targetJid }); } catch (e) {}
        return; 
    }

    if (cmd === '/hapussemuatopik') {
        if (!args[1] || args[1].toLowerCase() !== 'konfirmasi') {
            return balasPerintah(`⚠️ Peringatan: Ini akan menghapus SEMUA topik kontak/grup.\n\n👉 Ketik manual secara utuh untuk melanjutkan:\n\n/hapussemuatopik konfirmasi`);
        }
        const semuaJid = Object.keys(dbConfig.topik);
        await balasPerintah(`🔄 Menghapus ${semuaJid.length} topik, mohon tunggu...`);

        let berhasil = 0;
        for (const j of semuaJid) {
            try { await tgBot.deleteForumTopic(TG_GROUP_ID, dbConfig.topik[j]); berhasil++; } catch (e) {}
            await delay(300); 
        }
        dbConfig.topik = {};
        dbConfig.topicInfoMsgs = {};
        dbConfig.muted = [];
        await simpanKonfigurasiDB();
        try { await replyMapCollection.deleteMany({}); } catch (e) {}
        cacheAntiDelete.flushAll();

        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ ${berhasil}/${semuaJid.length} topik terhapus.`));
    }

    if (cmd === '/addkata') {
        const kataBaru = teks.slice(cmd.length).trim();
        if (!kataBaru) return balasPerintah(`⚠️ Ketik: \`/addkata kata1,kata2,kata3\``, { parse_mode: 'Markdown' });
        const daftarBaru = kataBaru.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        let ditambah = 0;
        for (const k of daftarBaru) {
            if (!dbConfig.kataKunci.includes(k)) { dbConfig.kataKunci.push(k); ditambah++; }
        }
        await simpanKonfigurasiDB();
        return balasPerintah(`✅ ${ditambah} kata kunci ditambahkan.`);
    }
    if (cmd === '/listkata') {
        if (dbConfig.kataKunci.length === 0) return balasPerintah(`Belum ada kata kunci.`);
        const daftar = dbConfig.kataKunci.map((k, i) => `${i + 1}.${k}`).join('\n');
        return balasPerintah(`🔑 *DAFTAR KATA KUNCI*\n\n${daftar}\n\nHapus dgn: /delkata [nomor]`, { parse_mode: 'Markdown' });
    }
    if (cmd === '/delkata') {
        const idx = parseInt(args[1]) - 1;
        if (isNaN(idx) || !dbConfig.kataKunci[idx]) return balasPerintah(`⚠️ Nomor tidak valid. Lihat /listkata dulu.`);
        const dihapus = dbConfig.kataKunci.splice(idx, 1);
        await simpanKonfigurasiDB();
        return balasPerintah(`✅ Kata kunci "${dihapus[0]}" dihapus.`);
    }
    if (cmd === '/blacklistkata' && targetJid) {
        if (!dbConfig.blacklistKataKunci.includes(targetJid)) dbConfig.blacklistKataKunci.push(targetJid);
        await simpanKonfigurasiDB();
        return balasPerintah(`✅ Kontak ini tidak akan memicu notif kata kunci lagi.`);
    }
    if (cmd === '/unblacklistkata' && targetJid) {
        dbConfig.blacklistKataKunci = dbConfig.blacklistKataKunci.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB();
        return balasPerintah(`✅ Blacklist kata kunci dicabut utk kontak ini.`);
    }
    if (cmd === '/listblacklistkata') {
        if (dbConfig.blacklistKataKunci.length === 0) return balasPerintah(`Belum ada kontak di blacklist kata kunci.`);
        const daftar = dbConfig.blacklistKataKunci.map((j) => `- ${ambilInfoKontak(j, null).nama}`).join('\n');
        return balasPerintah(`🚫 *BLACKLIST KATA KUNCI*\n\n${daftar}`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/nostatus' && targetJid) {
        if (!dbConfig.blacklistStatus.includes(targetJid)) dbConfig.blacklistStatus.push(targetJid);
        await simpanKonfigurasiDB();
        return balasPerintah(`✅ Status kontak ini tidak akan diunduh lagi.`);
    }
    if (cmd === '/yesstatus' && targetJid) {
        dbConfig.blacklistStatus = dbConfig.blacklistStatus.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB();
        return balasPerintah(`✅ Status kontak ini akan diunduh lagi.`);
    }
    if (cmd === '/liststatus') {
        if (dbConfig.blacklistStatus.length === 0) return balasPerintah(`Belum ada kontak di blacklist status.`);
        const daftar = dbConfig.blacklistStatus.map((j) => `- ${ambilInfoKontak(j, null).nama}`).join('\n');
        return balasPerintah(`🚫 *BLACKLIST STATUS*\n\n${daftar}`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/login') {
        const nomor = args[1]?.replace(/[^0-9]/g, '');
        if (!nomor) return balasPerintah(`⚠️ Format: \`/login 628123456789\``, { parse_mode: 'Markdown' });
        if (!globalSock) return balasPerintah(`⚠️ Socket belum siap, tunggu sebentar.`);
        if (globalSock.authState.creds.registered) return balasPerintah(`✅ Sudah login. Pakai /login lagi setelah logout kalau mau ganti nomor.`);

        dbConfig.nomor_wa_utama = nomor;
        await simpanKonfigurasiDB();
        try {
            let kode = await globalSock.requestPairingCode(nomor);
            kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
            return balasPerintah(`🔑 *KODE PAIRING:* \`${kode}\`\nMasukkan di WhatsApp > Perangkat Tertaut dlm 60 detik.`, { parse_mode: 'Markdown' });
        } catch (e) {
            return balasPerintah(`❌ Gagal: ${e.message}`);
        }
    }

    if (cmd === '/restart') {
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔄 Merestart bot...`, { message_thread_id: threadId }));
        try { if (globalSock) globalSock.end(undefined); } catch (e) {}
        try { await mongoClient.close(); } catch (e) {}
        await delay(1000); 
        process.exit(0);
    }

    const perluTargetJid = ['/info', '/mute', '/unmute', '/hapustopik', '/blacklistkata', '/unblacklistkata', '/nostatus', '/yesstatus'];
    if (teks.startsWith('/') && perluTargetJid.includes(cmd) && !targetJid) {
        return balasPerintah(`⚠️ Perintah ini harus dijalankan di DALAM topik kontak/grup yang dituju, bukan di sini.`);
    }

    if (!targetJid && threadId && !teks.startsWith('/') && teks.trim() !== '') {
        const isTopikSistem = Object.values(dbConfig.sysTopics).includes(threadId);
        if (!isTopikSistem) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID,
                `⚠️ Pesan ini tidak terkirim ke WA — topik ini bukan topik kontak/grup yang terhubung.`,
                { message_thread_id: threadId }));
        }
        return; 
    }
    if (!targetJid && !threadId && !teks.startsWith('/') && teks.trim() !== '') {
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID,
            `⚠️ Pesan di General tidak terkirim ke WA mana pun. Ketik di dalam topik kontak/grup yang dituju.`));
    }

    // ---- BALAS KE WA (teks & media) DARI TELEGRAM ----
    if (targetJid && globalSock && !teks.startsWith('/')) {
        
        if (!dbConfig.stealthMode) {
            try {
                await globalSock.sendPresenceUpdate('composing', targetJid);
                await delay(1200);
                await globalSock.sendPresenceUpdate('paused', targetJid);
            } catch (e) {}
        }

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

            let opsiKirim;
            if (msg.reply_to_message) {
                const target = await ambilPemetaanReply(msg.reply_to_message.message_id);
                if (target && target.waJid === targetJid) {
                    opsiKirim = { quoted: target.waMsg };
                }
            }

            const sent = await globalSock.sendMessage(targetJid, msgOptions, opsiKirim);
            msgMapCache.set(sent.key.id, { tgMsgId: msg.message_id, threadId });

            if (dbConfig.stealthMode) {
                try { await globalSock.sendPresenceUpdate('unavailable'); } catch (e) {}
            }
        } catch (e) {
            console.error('[KIRIM WA ERROR]', e.message);
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal kirim: ${e.message}`, { message_thread_id: threadId }));
        }
    }
});

// ---- MIRROR REAKSI TELEGRAM -> WA ----
tgBot.on('message_reaction', async (reaction) => {
    if (reaction.chat.id.toString() !== TG_GROUP_ID || !globalSock) return;
    const target = await ambilPemetaanReply(reaction.message_id);
    if (!target) return;

    const emojiBaru = reaction.new_reaction?.find((r) => r.type === 'emoji')?.emoji || '';
    try {
        await globalSock.sendMessage(target.waJid, { react: { text: emojiBaru, key: target.waMsg.key } });
    } catch (e) {
        console.error('[REACT KE WA ERROR]', e.message);
    }
});

// =========================================================================
// ANTREAN PENGIRIMAN KE TELEGRAM
// =========================================================================
async function masukAntrean(infoPesan, pushName = 'Kontak', isHistory = false, isFromMe = false) {
    antreanPesan.push({ infoPesan, pushName, isHistory, isFromMe });
    if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
}

async function jalankanPekerjaAntrean() {
    sedangMemprosesAntrean = true;
    try {
        while (antreanPesan.length > 0 || antreanStatus.length > 0) {
            if (antreanPesan.length > 0) {
                const { infoPesan, pushName, isHistory, isFromMe } = antreanPesan[0];
                try {
                    await withTimeout(eksekusiKirimKeTelegram(infoPesan, pushName, isHistory, isFromMe), 60000, 'KirimPesan');
                } catch (e) {
                    console.error('[ANTREAN PESAN ERROR] Melewati 1 pesan yg gagal diproses:', e.message);
                }
                antreanPesan.shift();
                if (antreanPesan.length % 10 === 0) perbaruiStatusTelegram(statusHpSaatIni);
                await delay(isHistory ? 1500 : 500);
            } else {
                const infoStatus = antreanStatus.shift();
                try {
                    await withTimeout(prosesStatusBroadcast(infoStatus), 60000, 'KirimStatus');
                } catch (e) {
                    console.error('[ANTREAN STATUS ERROR] Melewati 1 story yg gagal diproses:', e.message);
                }
                await delay(800);
            }
            if (global.gc && (antreanPesan.length + antreanStatus.length) % 20 === 0) global.gc();
        }
    } finally {
        sedangMemprosesAntrean = false;
        perbaruiStatusTelegram(statusHpSaatIni);
    }
}

async function prosesStatusBroadcast(infoPesan) {
    const isMyOwn = infoPesan.key.fromMe;
    let statusMsg = infoPesan.message;
    if (statusMsg.ephemeralMessage) statusMsg = statusMsg.ephemeralMessage.message;

    const infoPembuat = isMyOwn ? { nama: 'ANDA SENDIRI' } : ambilInfoKontak(infoPesan.key.participant, infoPesan.pushName);
    const teksKonten = statusMsg.conversation || statusMsg.extendedTextMessage?.text || '';
    const pesanMedia = statusMsg.imageMessage || statusMsg.videoMessage;

    const contextInfo = statusMsg.extendedTextMessage?.contextInfo || statusMsg.imageMessage?.contextInfo || statusMsg.videoMessage?.contextInfo || infoPesan.contextInfo;
    const statusJidList = contextInfo?.statusJidList || contextInfo?.bcastJidList || [];
    statusMemory.set(infoPesan.key.id, { teks: teksKonten, media: !!pesanMedia, audience: statusJidList, viewers: [] });
    const privasiInfo = isMyOwn
        ? (statusJidList.length > 0 ? `\n🔒 _Diizinkan dilihat oleh ${statusJidList.length} kontak (daftar menyusul)_` : `\n🔒 _Daftar penerima tidak terbaca dari data pesan ini_`)
        : '';
    const caption = `📱 *Status: ${infoPembuat.nama}*\n${teksKonten}${privasiInfo}`;

    try {
        let hasilStatus;
        if (pesanMedia) {
            const tipeUnduh = statusMsg.imageMessage ? 'image' : 'video';
            const stream = await downloadContentFromMessage(pesanMedia, tipeUnduh);
            let buffer = Buffer.alloc(0);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            hasilStatus = await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendDocument(TG_GROUP_ID, buffer, { message_thread_id: tId, caption, parse_mode: 'Markdown' }));
        } else {
            hasilStatus = await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, caption, { message_thread_id: tId, parse_mode: 'Markdown' }));
        }
        if (hasilStatus?.message_id) cacheWaMsgToTg.set(infoPesan.key.id, hasilStatus.message_id);
    } catch (e) { console.error('[STATUS ERROR]', e.message); }

    if (isMyOwn && statusJidList.length > 0) {
        await delay(800);
        const daftarPenerima = statusJidList.map((j) => `- ${ambilInfoKontak(j, null).nama}`);
        for (let i = 0; i < daftarPenerima.length; i += 100) {
            await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👥 *Diizinkan Melihat Status Ini:*\n\n${daftarPenerima.slice(i, i + 100).join('\n')}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
            await delay(500);
        }
    }
}

async function eksekusiKirimKeTelegram(infoPesan, pushName, isHistory, isFromMe = false) {
    const idPengirim = infoPesan.key.remoteJid;
    if (dbConfig.muted.includes(idPengirim)) return;

    try {
        await pastikanTopik(idPengirim, pushName);
    } catch (e) {
        return;
    }

    const kirim = async (fn) => {
        const hasil = await kirimKeTopik({ jid: idPengirim }, fn);
        if (hasil?.message_id) {
            simpanPemetaanReply(hasil.message_id, { waJid: idPengirim, waMsg: { key: infoPesan.key, message: infoPesan.message } });
            cacheWaMsgToTg.set(infoPesan.key.id, hasil.message_id);
        }
        return hasil;
    };
    const awalan = isHistory ? '🕰️ [Riwayat] ' : '';

    let isiPesan = infoPesan.message;
    if (isiPesan?.ephemeralMessage) isiPesan = isiPesan.ephemeralMessage.message;
    if (isiPesan?.documentWithCaptionMessage) isiPesan = isiPesan.documentWithCaptionMessage.message;
    
    if (!isiPesan) return; 
    
    const tipePesan = Object.keys(isiPesan).find((k) => k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo');
    if (!tipePesan) return;

    const infoUtama = ambilInfoKontak(idPengirim, pushName);
    const infoPengirimAsli = (infoUtama.isGrup && infoPesan.key.participant)
        ? ambilInfoKontak(infoPesan.key.participant, infoPesan.pushName)
        : infoUtama;
    const namaPengirimFinal = isFromMe ? 'Anda' : infoPengirimAsli.nama;
    const prefixArah = isFromMe ? `📤 *Anda:*\n` : (infoUtama.isGrup ? `👤 *[${infoPengirimAsli.nama}]*:\n` : '');

    if (isiPesan.reactionMessage) {
        const emoji = isiPesan.reactionMessage.text || '';
        const targetId = isiPesan.reactionMessage.key.id;
        const dataAsli = cacheAntiDelete.get(targetId);
        const tgTargetMsgId = cacheWaMsgToTg.get(targetId) || msgMapCache.get(targetId)?.tgMsgId;

        if (emoji && tgTargetMsgId) await setTGReaksi(tgTargetMsgId, emoji);

        const labelEmoji = emoji || '(dihapus)';
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}[Reaksi ${labelEmoji} dari ${namaPengirimFinal}] pada: "_${dataAsli?.teks || 'pesan/media'}_"`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    const viewOnceKeys = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    const mediaDgnFlagVO = isiPesan.imageMessage || isiPesan.videoMessage || isiPesan.audioMessage;
    const isViewOnce = viewOnceKeys.includes(tipePesan) || mediaDgnFlagVO?.viewOnce === true;
    if (isViewOnce) {
        const teksVO = `${awalan}👁️ *Pesan Sekali-Lihat*\n👤 Dari: ${namaPengirimFinal}\nℹ️ Sesuai desain privasi WhatsApp, isi pesan ini tidak diteruskan atau disimpan oleh bot.`;
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, teksVO, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    if (isiPesan.locationMessage) {
        const loc = isiPesan.locationMessage;
        await kirim((tId) => tgBot.sendLocation(TG_GROUP_ID, loc.degreesLatitude, loc.degreesLongitude, { message_thread_id: tId }));
        if (loc.name) await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `📍 ${loc.name}`, { message_thread_id: tId }));
        return;
    }
    if (isiPesan.liveLocationMessage) {
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}📍 Membagikan lokasi langsung (tidak diteruskan real-time).`, { message_thread_id: tId }));
        return;
    }

    if (isiPesan.contactMessage) {
        const vc = parseVCard(isiPesan.contactMessage.vcard);
        if (vc?.nama) {
            for (const nomor of vc.nomorList) {
                const kemungkinanJid = `${nomor}@s.whatsapp.net`;
                if (dbConfig.topik[kemungkinanJid]) await renameTopikJikaPerlu(kemungkinanJid, vc.nama, false);
            }
        }
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}${prefixArah}👤 Membagikan kontak: *${isiPesan.contactMessage.displayName}*`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }
    if (isiPesan.contactsArrayMessage) {
        const daftarKontak = isiPesan.contactsArrayMessage.contacts || [];
        for (const c of daftarKontak) {
            const vc = parseVCard(c.vcard);
            if (vc?.nama) {
                for (const nomor of vc.nomorList) {
                    const kemungkinanJid = `${nomor}@s.whatsapp.net`;
                    if (dbConfig.topik[kemungkinanJid]) await renameTopikJikaPerlu(kemungkinanJid, vc.nama, false);
                }
            }
        }
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}${prefixArah}👥 Membagikan ${daftarKontak.length} kontak`, { message_thread_id: tId }));
        return;
    }

    if (isiPesan.pollCreationMessage || isiPesan.pollCreationMessageV3) {
        const poll = isiPesan.pollCreationMessage || isiPesan.pollCreationMessageV3;
        const daftarOpsi = (poll.options || []).map((o) => `• ${o.optionName}`).join('\n');
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}${prefixArah}📊 *Polling:* ${poll.name}\n${daftarOpsi}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    if (isiPesan.stickerMessage) {
        try {
            if (prefixArah) await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, prefixArah.trim(), { message_thread_id: tId, parse_mode: 'Markdown' }));
            const stream = await downloadContentFromMessage(isiPesan.stickerMessage, 'sticker');
            let buffer = Buffer.alloc(0);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await kirim((tId) => tgBot.sendSticker(TG_GROUP_ID, buffer, { message_thread_id: tId }));
        } catch (e) { console.error('[STIKER ERROR]', e.message); }
        return;
    }

    const teksKonten = isiPesan.conversation || isiPesan.extendedTextMessage?.text || isiPesan[tipePesan]?.caption || '';
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan, pengirim: namaPengirimFinal, isGrup: infoUtama.isGrup });

    const contextInfo = isiPesan.extendedTextMessage?.contextInfo || isiPesan.imageMessage?.contextInfo
        || isiPesan.videoMessage?.contextInfo || isiPesan.documentMessage?.contextInfo || isiPesan.stickerMessage?.contextInfo
        || isiPesan.audioMessage?.contextInfo;
    let quoteBlock = '';
    const botJid = globalSock?.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');

    const buatLinkTelegram = (tId, msgId) => (tId && msgId) ? `https://t.me/c/${groupIdBersih}/${tId}/${msgId}` : '';
    const labelKontenQuoted = (qm) => {
        if (!qm) return '[Pesan]';
        if (qm.conversation) return qm.conversation;
        if (qm.extendedTextMessage?.text) return qm.extendedTextMessage.text;
        if (qm.imageMessage) return qm.imageMessage.caption ? `[Foto] ${qm.imageMessage.caption}` : '[Foto]';
        if (qm.videoMessage) return qm.videoMessage.caption ? `[Video] ${qm.videoMessage.caption}` : '[Video]';
        if (qm.documentMessage) return `[Dokumen] ${qm.documentMessage.fileName || ''}`.trim();
        if (qm.audioMessage) return qm.audioMessage.ptt ? '[Voice Note]' : '[Audio]';
        if (qm.stickerMessage) return '[Stiker]';
        if (qm.locationMessage) return '[Lokasi]';
        if (qm.contactMessage) return '[Kontak]';
        return '[Media]';
    };

    if (contextInfo?.quotedMessage) {
        const isQuoteStatus = contextInfo.remoteJid === 'status@broadcast';
        const labelKonten = labelKontenQuoted(contextInfo.quotedMessage);

        if (isQuoteStatus) {
            const statMem = statusMemory.get(contextInfo.stanzaId);
            const isiStatus = labelKonten !== '[Pesan]' ? labelKonten : (statMem?.teks || '[Media Status]');
            const linkStatus = buatLinkTelegram(dbConfig.sysTopics.statusWA, cacheWaMsgToTg.get(contextInfo.stanzaId));
            const infoAudiens = statMem
                ? `\n> 🔒 Diizinkan lihat: ${statMem.audience?.length ?? '?'} kontak | 👀 Sudah lihat: ${statMem.viewers?.length ?? 0} kontak`
                : `\n> ℹ️ _Data audiens/viewer status ini tidak tersimpan_`;
            quoteBlock = `> 📝 *Membalas Status${contextInfo.participant === botJid ? ' Anda' : ''}:* _${isiStatus}_${infoAudiens}${linkStatus ? `\n> 🔗 [Lihat status](${linkStatus})` : ''}\n\n`;
        } else {
            const infoPengirimQuoted = contextInfo.participant ? ambilInfoKontak(contextInfo.participant, null) : null;
            const labelPengirim = infoPengirimQuoted ? infoPengirimQuoted.nama : namaPengirimFinal;
            const linkQuoted = buatLinkTelegram(dbConfig.topik[idPengirim], cacheWaMsgToTg.get(contextInfo.stanzaId));
            quoteBlock = `> 📝 *Membalas ${labelPengirim}:* _${labelKonten}_${linkQuoted ? `\n> 🔗 [Lihat pesan asli](${linkQuoted})` : ''}\n\n`;
        }
    }

    const mentionedList = contextInfo?.mentionedJid || [];
    const botDiTag = mentionedList.includes(botJid);
    let tagNotice = '';
    if (mentionedList.length > 0) {
        const namaList = mentionedList.map((j) => ambilInfoKontak(j, null).nama).join(', ');
        tagNotice += `🔖 *Men-tag:* ${namaList}\n`;
    }
    if (botDiTag) tagNotice += `🔔 *[NOMOR ANDA DI-MENTION]*\n`;
    if (tagNotice) tagNotice += '\n';

    const pesanMedia = isiPesan.imageMessage || isiPesan.videoMessage || isiPesan.documentMessage || isiPesan.audioMessage || isiPesan.ptvMessage;
    
    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            
            if (ukuranBytes > dbConfig.maxMediaMB * 1024 * 1024) {
                const fallbackGagalBesar = `⚠️ [Media ${Math.round(ukuranBytes/1024/1024)}MB dilewati (Batas: ${dbConfig.maxMediaMB}MB)]`;
                const hasilKirim = await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${awalan}${prefixArah}${quoteBlock}${fallbackGagalBesar}\n💬 ${teksKonten}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
                await cekKataKunci(idPengirim, isFromMe, isHistory, namaPengirimFinal, teksKonten, hasilKirim);
                return;
            }
            
            let tipeUnduh = '';
            if (isiPesan.imageMessage) tipeUnduh = 'image';
            else if (isiPesan.videoMessage || isiPesan.ptvMessage) tipeUnduh = 'video';
            else if (isiPesan.documentMessage) tipeUnduh = 'document';
            else if (isiPesan.audioMessage) tipeUnduh = 'audio';

            try {
                const stream = await downloadContentFromMessage(pesanMedia, tipeUnduh);
                let buffer = Buffer.alloc(0);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                const hasilKirim = await kirim((tId) => tgBot.sendDocument(TG_GROUP_ID, buffer,
                    { message_thread_id: tId, caption: `${tagNotice}${awalan}${prefixArah}${quoteBlock}${teksKonten}`, parse_mode: 'Markdown' },
                    { filename: `media_${infoPesan.key.id}` }));
                await cekKataKunci(idPengirim, isFromMe, isHistory, namaPengirimFinal, teksKonten, hasilKirim);
                await notifikasiMentionDiri(botDiTag, idPengirim, hasilKirim);
            } catch (dlErr) {
                const fallbackGagal = `⚠️ [Sistem gagal mengunduh media dari WA]`;
                await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${awalan}${prefixArah}${quoteBlock}${fallbackGagal}\n💬 ${teksKonten}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
            }
        } else if (teksKonten.trim() !== '') {
            const hasilKirim = await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${awalan}${prefixArah}${quoteBlock}💬 ${teksKonten}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
            await cekKataKunci(idPengirim, isFromMe, isHistory, namaPengirimFinal, teksKonten, hasilKirim);
            await notifikasiMentionDiri(botDiTag, idPengirim, hasilKirim);
        }
    } catch (e) {
        console.error('[TG SEND ERROR]', e.message);
    }
}

async function notifikasiMentionDiri(botDiTag, idPengirim, hasilKirim) {
    if (!botDiTag || !hasilKirim?.message_id) return;
    const threadId = dbConfig.topik[idPengirim];
    if (!threadId) return;
    const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');
    const link = `https://t.me/c/${groupIdBersih}/${threadId}/${hasilKirim.message_id}`;
    await kirimKeTopik({ sysKey: 'aktivitas' }, (tId) => tgBot.sendMessage(TG_GROUP_ID,
        `🔔 *Nomor Anda di-mention!*\n🔗 [Lihat Pesan](${link})`, { message_thread_id: tId, parse_mode: 'Markdown' }));
}

async function cekKataKunci(idPengirim, isFromMe, isHistory, namaPengirim, teksKonten, hasilKirim) {
    if (isFromMe || isHistory || !teksKonten || dbConfig.kataKunci.length === 0) return;
    if (dbConfig.blacklistKataKunci.includes(idPengirim)) return;

    const teksLower = teksKonten.toLowerCase();
    const cocok = dbConfig.kataKunci.find((k) => teksLower.includes(k));
    if (!cocok) return;

    let tautan = '';
    if (hasilKirim?.message_id && dbConfig.topik[idPengirim]) {
        const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');
        tautan = `\n🔗 [Lihat Pesan](https://t.me/c/${groupIdBersih}/${dbConfig.topik[idPengirim]}/${hasilKirim.message_id})`;
    }

    await kirimKeTopik({ sysKey: 'kataKunci' }, (tId) => tgBot.sendMessage(TG_GROUP_ID,
        `🔔 *Kata Kunci Terdeteksi:* "${cocok}"\n👤 Dari: ${namaPengirim}\n💬 Isi: "${teksKonten}"${tautan}`,
        { message_thread_id: tId, parse_mode: 'Markdown' }));
}

// =========================================================================
// MESIN WHATSAPP UTAMA
// =========================================================================
async function mulaiBotWhatsApp() {
    try {
        const { state, saveCreds } = await useMongoDBAuthState();
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 20000,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        const sendNodeAsli = sock.sendNode.bind(sock);
        sock.sendNode = async (stanza) => {
            if (dbConfig.stealthMode && stanza && stanza.tag === 'receipt') {
                const attrs = stanza.attrs || {};
                if (attrs.type === 'read' || attrs.type === 'read-self' || (attrs.to && attrs.to.includes('status@broadcast'))) {
                    return; 
                }
            }
            return await sendNodeAsli(stanza);
        };

        globalSock = sock;

        sock.ev.on('contacts.upsert', async (contacts) => {
            let changed = false;
            for (const c of contacts) {
                const nama = c.name || c.notify;
                if (c.lid && c.id) {
                    dbConfig.lidMap[c.lid] = c.id;
                    changed = true;
                }
                if (nama) {
                    if (c.id) await renameTopikJikaPerlu(c.id, nama, false);
                    if (c.lid) {
                        dbConfig.kontak[c.lid] = nama;
                        await renameTopikJikaPerlu(c.lid, nama, false);
                    }
                    changed = true;
                }
            }
            if (changed) await simpanKonfigurasiDB();
        });

        sock.ev.on('contacts.update', async (updates) => {
            let changed = false;
            for (const c of updates) {
                const nama = c.name || c.notify;
                if (c.lid && c.id) {
                    dbConfig.lidMap[c.lid] = c.id;
                    changed = true;
                }
                if (nama) {
                    if (c.id) await renameTopikJikaPerlu(c.id, nama, false);
                    if (c.lid) {
                        dbConfig.kontak[c.lid] = nama;
                        await renameTopikJikaPerlu(c.lid, nama, false);
                    }
                    changed = true;
                }
            }
            if (changed) await simpanKonfigurasiDB();
        });

        sock.ev.on('groups.upsert', async (groups) => {
            let changed = false;
            for (const g of groups) {
                if (g.subject) await renameTopikJikaPerlu(g.id, g.subject, true);
                if (g.participants) {
                    for (const p of g.participants) {
                        if (p.lid && p.id && !dbConfig.lidMap[p.lid]) {
                            dbConfig.lidMap[p.lid] = p.id;
                            changed = true;
                            if (dbConfig.topik[p.lid]) {
                                await renameTopikJikaPerlu(p.lid, dbConfig.kontak[p.lid] || p.id.split('@')[0], false);
                            }
                        }
                    }
                }
            }
            if (changed) await simpanKonfigurasiDB();
        });

        sock.ev.on('groups.update', async (updates) => {
            for (const g of updates) if (g.subject && g.id) await renameTopikJikaPerlu(g.id, g.subject, true);
        });

        sock.ev.on('chats.upsert', async (chats) => {
            for (const c of chats) {
                const isGrup = c.id?.endsWith('@g.us');
                if (c.name && !isGrup) await renameTopikJikaPerlu(c.id, c.name, false);
            }
        });
        sock.ev.on('chats.update', async (updates) => {
            for (const c of updates) {
                const isGrup = c.id?.endsWith('@g.us');
                if (c.name && c.id && !isGrup) await renameTopikJikaPerlu(c.id, c.name, false);
            }
        });

        let bufferRiwayat = [];
        
        sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
            if (contacts) {
                for (const c of contacts) {
                    const nama = c.name || c.notify;
                    const pnJid = c.id;
                    const lidJid = c.lid;

                    if (nama) {
                        if (pnJid) dbConfig.kontak[pnJid] = nama;
                        if (lidJid) dbConfig.kontak[lidJid] = nama;
                    }
                    if (lidJid && pnJid) {
                        dbConfig.lidMap[lidJid] = pnJid;
                    }
                }
                await simpanKonfigurasiDB();
            }
            if (messages && messages.length > 0) {
                bufferRiwayat.push(...messages.filter((m) => m.message && !m.key.fromMe));
            }
        });

        setTimeout(function jadwalSinkronRiwayat() {
            (async () => {
                if (bufferRiwayat.length === 0) { setTimeout(jadwalSinkronRiwayat, 60000); return; }
                sedangSinkronisasi = true;
                perbaruiStatusTelegram(statusHpSaatIni, true);

                try {
                    const perKontak = {};
                    for (const msg of bufferRiwayat) {
                        const jid = msg.key.remoteJid;
                        if (!perKontak[jid]) perKontak[jid] = [];
                        if (perKontak[jid].length < HISTORY_BATCH_SIZE) perKontak[jid].push(msg);
                    }
                    bufferRiwayat = [];

                    for (const jid of Object.keys(perKontak)) {
                        const pesanTerurut = perKontak[jid].sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
                        for (const msg of pesanTerurut) masukAntrean(msg, msg.pushName, true);
                        await delay(3000);
                    }
                } catch (e) {
                    console.error('[SINKRON RIWAYAT ERROR]', e.message);
                } finally {
                    sedangSinkronisasi = false;
                    perbaruiStatusTelegram(statusHpSaatIni, true);
                    setTimeout(jadwalSinkronRiwayat, 60 * 60 * 1000);
                }
            })();
        }, HISTORY_SYNC_DELAY_MS);

        sock.ev.on('presence.update', async (presence) => {
            const jid = presence.id;
            const state = presence.presences[Object.keys(presence.presences)[0]]?.lastKnownPresence;

            let icon = '🔴 Offline';
            if (state === 'available') {
                icon = '🟢 Online';
                lastSeenMap[jid] = null; 
            } else if (state === 'composing') {
                icon = '✍️ Mengetik...';
            } else if (state === 'recording') {
                icon = '🎤 Merekam suara...';
            } else {
                lastSeenMap[jid] = Date.now();
            }
            currentStatusMap[jid] = icon; 

            const msgId = dbConfig.topicInfoMsgs[jid];
            if (!msgId) return;

            const info = ambilInfoKontak(jid, null);
            let baris = `ℹ️ *INFO KONTAK*\nNama: ${info.nama}\nNomor: ${info.nomor !== 'Disembunyikan (LID)' ? '+' + info.nomor : 'LID'}\nStatus: `;
            baris += icon;
            if (icon === '🔴 Offline' && lastSeenMap[jid]) {
                baris += `\n🕒 Terakhir terlihat: ${waktuLokal(new Date(lastSeenMap[jid]))}`;
            }

            safeTG(() => tgBot.editMessageText(baris, { chat_id: TG_GROUP_ID, message_id: msgId, parse_mode: 'Markdown' }));
        });

        async function mintaKodePairing(retryCount = 0) {
            try {
                if (!globalSock || sock.authState.creds.registered || sudahMemintaKode || !dbConfig.nomor_wa_utama) return;
                sudahMemintaKode = true;
                const nomor = dbConfig.nomor_wa_utama.replace(/[^0-9]/g, '');
                let kode = await sock.requestPairingCode(nomor);
                kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔑 *KODE PAIRING:* \`${kode}\`\nNomor: ${nomor}`, { parse_mode: 'Markdown' }));
            } catch (err) {
                console.error(`[PAIRING ERROR] percobaan ke-${retryCount + 1}:`, err.message);
                sudahMemintaKode = false;
                if (retryCount < 3) setTimeout(() => mintaKodePairing(retryCount + 1), 5000);
                else await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal pairing otomatis. Kirim /login [nomor] secara manual.`));
            }
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'connecting' && !sock.authState.creds.registered && !sedangMenungguPairing && dbConfig.nomor_wa_utama) {
                sedangMenungguPairing = true;
                setTimeout(() => mintaKodePairing(0), 2000);
            }

            if (connection === 'close') {
                globalSock = null; sedangMenungguPairing = false; sudahMemintaKode = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

                if (isLoggedOut) {
                    try { await authCollection.deleteMany({}); } catch (e) {}
                    perbaruiStatusTelegram(`Logout (${statusCode}) - perlu /login ulang.`, true);
                } else {
                    perbaruiStatusTelegram(`Terputus (${statusCode || '?'}), menyambung ulang...`, true);
                }
                setTimeout(mulaiBotWhatsApp, 5000);
            } else if (connection === 'open') {
                sedangMenungguPairing = false;
                if (dbConfig.stealthMode) {
                    try { await sock.sendPresenceUpdate('unavailable'); } catch (e) {}
                }
                perbaruiStatusTelegram('Online');
                if (!sock.authState.creds.registered) {
                    safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Terhubung tapi belum login. Kirim \`/login 628xxx\`.`, { parse_mode: 'Markdown' }));
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        const callStateMap = {};
        const kirimLogPanggilan = async (callFromJid, teks) => {
            await kirimKeTopik({ sysKey: 'audit' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, teks, { message_thread_id: tId, parse_mode: 'Markdown' }));
            try {
                await pastikanTopik(callFromJid);
                await kirimKeTopik({ jid: callFromJid }, (tId) => tgBot.sendMessage(TG_GROUP_ID, teks, { message_thread_id: tId, parse_mode: 'Markdown' }));
            } catch (e) { }
        };

        sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                const callId = call.id;
                const info = ambilInfoKontak(call.from, null);
                const jenis = call.isVideo ? 'Video' : 'Suara';
                const labelGrup = call.isGroup ? ' GRUP' : '';

                if (call.status === 'offer' || call.status === 'ringing') {
                    if (callStateMap[callId]?.notifDering) continue; 
                    callStateMap[callId] = { ...(callStateMap[callId] || {}), startTime: Date.now(), answered: false, notifDering: true };
                    await kirimLogPanggilan(call.from, `📞 *[PANGGILAN ${jenis}${labelGrup} MASUK]*\n👤 ${call.isGroup ? 'Grup' : 'Dari'}: ${info.nama}\n🕒 ${waktuLokal()}`);
                    continue;
                }

                if (call.status === 'reject' || call.status === 'timeout') {
                    const state = callStateMap[callId];
                    if (state?.notifSelesai) continue;
                    if (state) state.notifSelesai = true; else callStateMap[callId] = { notifSelesai: true };
                    const label = call.status === 'reject' ? 'Ditolak' : 'Tidak Terjawab';
                    await kirimLogPanggilan(call.from, `📞 *[PANGGILAN ${label.toUpperCase()}]*\n👤 Dari: ${info.nama}`);
                    delete callStateMap[callId];
                    continue;
                }

                if (call.status === 'accept') {
                    if (callStateMap[callId]?.notifDiangkat) continue; 
                    if (callStateMap[callId]) {
                        callStateMap[callId].answered = true;
                        callStateMap[callId].acceptTime = Date.now();
                        callStateMap[callId].notifDiangkat = true;
                    } else {
                        callStateMap[callId] = { startTime: Date.now(), acceptTime: Date.now(), answered: true, notifDiangkat: true };
                    }
                    await kirimLogPanggilan(call.from, `📞 *[PANGGILAN DIANGKAT]*\n👤 Dengan: ${info.nama}\nStatus: sedang berlangsung`);
                    continue;
                }

                if (call.status === 'terminate') {
                    const state = callStateMap[callId];
                    if (state?.notifSelesai) continue; 
                    if (state) state.notifSelesai = true;

                    if (state?.answered) {
                        const durasiDetik = Math.max(0, Math.round((Date.now() - state.acceptTime) / 1000));
                        const menit = Math.floor(durasiDetik / 60);
                        const detik = durasiDetik % 60;
                        await kirimLogPanggilan(call.from,
                            `📞 *[SESI PANGGILAN DITUTUP]*\n👤 Dengan: ${info.nama}\n⏱️ ~${menit}m ${detik}d sejak diangkat\n` +
                            `ℹ️ _Catatan: sinyal ini juga muncul kalau panggilan ditangani di HP utama — durasi di atas perkiraan, bukan kepastian._`);
                        continue;
                    }
                    if (!state) {
                        await kirimLogPanggilan(call.from, `📞 *[PANGGILAN BERAKHIR]*\n👤 Dengan: ${info.nama}`);
                    }
                    delete callStateMap[callId];
                }
            }
        });

        sock.ev.on('group-participants.update', async (event) => {
            try {
                await pastikanTopik(event.id);
                const daftarNama = event.participants.map((p) => ambilInfoKontak(p, null).nama).join(', ');
                const aksi = { add: '➕ Bergabung', remove: '➖ Keluar/dikeluarkan', promote: '⬆️ Dijadikan admin', demote: '⬇️ Admin dicabut' }[event.action] || event.action;
                await kirimKeTopik({ jid: event.id }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👥 [GRUP] ${aksi}: ${daftarNama}`, { message_thread_id: tId }));
            } catch (e) { console.error('[GROUP EVENT ERROR]', e.message); }
        });

        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                if (update.key.remoteJid === 'status@broadcast' && update.update.status === 4) {
                    const info = ambilInfoKontak(update.key.participant, null);
                    const statMem = statusMemory.get(update.key.id);
                    if (statMem) {
                        if (!statMem.viewers.includes(update.key.participant)) statMem.viewers.push(update.key.participant);
                        statusMemory.set(update.key.id, statMem);
                    }
                    kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👀 *${info.nama}* melihat status Anda:\n👉 _"${statMem?.teks || 'Media'}"_`,
                        { message_thread_id: tId, parse_mode: 'Markdown' }));
                    continue;
                }

                if (update.update.status) {
                    const tgData = msgMapCache.get(update.key.id);
                    if (tgData) {
                        const st = update.update.status;
                        if (st === 2) await setTGReaksi(tgData.tgMsgId, '👍');
                        else if (st === 3) await setTGReaksi(tgData.tgMsgId, '👌');
                        else if (st === 4) {
                            await setTGReaksi(tgData.tgMsgId, '👀');
                            msgMapCache.del(update.key.id);
                        }
                    }
                }

                if (update.update.protocolMessage) {
                    await prosesProtokolPesan(update.update.protocolMessage, update.key.participant);
                }
            }
        });

        sock.ev.on('chats.delete', (ids) => {
            console.log('[INFO] chats.delete diabaikan sengaja agar cadangan Telegram tetap utuh:', ids);
        });

        sock.ev.on('messages.upsert', async (chatUpdate) => {
            const infoPesan = chatUpdate.messages[0];
            if (!infoPesan || !infoPesan.message) return;

            const pushName = infoPesan.pushName || 'Kontak';
            const jid = infoPesan.key.remoteJid;

            const protoLangsung = infoPesan.message.protocolMessage;
            const protoDalamEdit = infoPesan.message.editedMessage?.message?.protocolMessage;
            if (protoLangsung || protoDalamEdit) {
                await prosesProtokolPesan(protoLangsung || protoDalamEdit, infoPesan.key.participant);
                return;
            }

            if (jid === 'status@broadcast') {
                const isMyOwn = infoPesan.key.fromMe;
                if (!isMyOwn && dbConfig.blacklistStatus.includes(infoPesan.key.participant)) return;
                antreanStatus.push(infoPesan);
                if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
                return;
            }

            const idPesan = infoPesan.key.id;
            
            let isiPesan = infoPesan.message;
            if (isiPesan?.ephemeralMessage) isiPesan = isiPesan.ephemeralMessage.message;
            if (isiPesan?.documentWithCaptionMessage) isiPesan = isiPesan.documentWithCaptionMessage.message;
            
            const tipePesan = isiPesan ? Object.keys(isiPesan).find((k) => k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo') : null;
            if (!tipePesan) return; 

            if (infoPesan.key.fromMe) {
                if (!msgMapCache.has(idPesan)) {
                    masukAntrean(infoPesan, pushName, false, true);
                }
                return;
            }

            if (cacheAntiSpam.has(idPesan)) return;
            cacheAntiSpam.set(idPesan, true);

            masukAntrean(infoPesan, pushName, false);
        });
    } catch (err) {
        console.error('[WA INIT ERROR]', err.message);
        setTimeout(mulaiBotWhatsApp, 10000);
    }
}

// =========================================================================
// EXPRESS SERVER, HEARTBEAT, GARBAGE COLLECTOR
// =========================================================================
setInterval(() => { if (global.gc) global.gc(); }, 120000);

const startTimeBot = Date.now();
setInterval(async () => {
    if (!configCollection) return;
    try {
        await configCollection.updateOne(
            { _id: 'heartbeat' },
            { $set: {
                connected: !!globalSock,
                uptimeMs: Date.now() - startTimeBot,
                ramMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                queueLength: antreanPesan.length + antreanStatus.length,
                updatedAt: new Date()
            } },
            { upsert: true }
        );
    } catch (e) { console.error('[HEARTBEAT ERROR]', e.message); }
}, 20000);

const app = express();
app.get('/', (req, res) => res.send('WA-Tele Bridge Aktif 🚀'));

process.on('SIGTERM', async () => {
    console.log('[SYS] Sinyal shutdown diterima.');
    if (globalSock) globalSock.end();
    await mongoClient.close();
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server aktif di port ${PORT}.`);
    inisialisasiDenganRetry();
});

async function inisialisasiDenganRetry(percobaan = 1) {
    try {
        await hubungkanDatabase();
        await mulaiBotWhatsApp();
    } catch (e) {
        console.error(`[STARTUP ERROR] Percobaan ke-${percobaan} gagal:`, e.message);
        if (percobaan < 5) {
            console.log(`[STARTUP] Coba lagi dalam 5 detik... (${percobaan}/5)`);
            await new Promise((r) => setTimeout(r, 5000));
            return inisialisasiDenganRetry(percobaan + 1);
        }
        console.error('[STARTUP ERROR] Menyerah setelah 5 percobaan. Keluar.');
        await new Promise((r) => setTimeout(r, 1500)); 
        process.exit(1);
    }
}
