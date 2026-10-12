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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inisialisasiMTProto, uploadBesarMTProto } = require('./mtprotoUploader');

// =========================================================================
// KONFIGURASI LINGKUNGAN
// =========================================================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_GROUP_ID = process.env.TG_GROUP_ID;
const MONGODB_URI = process.env.MONGODB_URI;
const TG_API_ID = process.env.TG_API_ID;
const TG_API_HASH = process.env.TG_API_HASH;

let envMissing = false;
if (!TG_TOKEN) envMissing = true;
if (!TG_GROUP_ID) envMissing = true;
if (!MONGODB_URI) envMissing = true;

if (envMissing) {
    console.error('[FATAL] Pastikan TG_TOKEN, TG_GROUP_ID, MONGODB_URI sudah diset di Environment Variables.');
    process.exit(1);
}

const HISTORY_SYNC_DELAY_MS = 15 * 60 * 1000;
const ZONA_WAKTU = process.env.TIMEZONE ? process.env.TIMEZONE : 'Asia/Jakarta'; 

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
    { command: 'mystatus', description: 'Laporan viewer status Anda' },
    { command: 'info', description: 'Detail kontak topik ini' },
    { command: 'mute', description: 'Bisukan topik ini' },
    { command: 'unmute', description: 'Bunyikan topik ini' },
    { command: 'login', description: 'Tautkan/ganti nomor WA' },
    { command: 'restart', description: 'Restart server bot' }
]);

const cacheAntiSpam = new NodeCache({ stdTTL: 3600, maxKeys: 1500, checkperiod: 600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400, maxKeys: 1500, checkperiod: 600 });
const cacheDedupProtokol = new NodeCache({ stdTTL: 120, maxKeys: 500 });
const statusMemory = new NodeCache({ stdTTL: 86400, maxKeys: 1000 });
const msgMapCache = new NodeCache({ stdTTL: 86400, maxKeys: 2000 });
const cacheTgMsgToWaMemori = new NodeCache({ stdTTL: 3 * 86400, maxKeys: 2000 });
const cacheWaMsgToTg = new NodeCache({ stdTTL: 3 * 86400, maxKeys: 2000 });

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
let isUploadingBigFile = false;
const lastSeenMap = {}; 

let dbConfig = {
    topik: {},
    kontak: {},
    sysTopics: {},
    muted: [],
    nomor_wa_utama: process.env.NOMOR_WA_UTAMA ? process.env.NOMOR_WA_UTAMA : null,
    pinned_status_msg_id: null,
    maxMediaMB: 2000,
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
            let isRateLimit = false;
            if (e.message) {
                if (e.message.includes('429')) isRateLimit = true;
            }
            if (isRateLimit) {
                const matched = e.message.match(/retry after (\d+)/);
                const waitStr = matched ? matched[1] : '30';
                const wait = parseInt(waitStr, 10);
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
    let noData = false;
    if (!nama) {
        if (nomorList.length === 0) noData = true;
    }
    if (noData) return null;
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
    if (pesanError.includes('thread not found')) return true;
    if (pesanError.includes('TOPIC_ID_INVALID')) return true;
    if (pesanError.includes('message thread not found')) return true;
    return false;
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
        const identitas = sysKey ? sysKey : jid;
        console.log(`[TOPIK STALE] Thread ${threadId} tidak valid lagi (${identitas}), membuat ulang...`);

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

    await inisialisasiMTProto(configCollection, TG_API_ID, TG_API_HASH, TG_TOKEN);
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
    if (isLid) {
        if (dbConfig.lidMap[jid]) {
            targetPnJid = dbConfig.lidMap[jid];
        }
    }

    const nomorAsli = targetPnJid.split('@')[0];
    
    let nama = dbConfig.kontak[targetPnJid];
    if (!nama) nama = dbConfig.kontak[jid];
    if (!nama) nama = pushNameFallback;

    if (!nama) {
        if (isGrup) {
            nama = 'Grup ' + nomorAsli;
        } else if (isLid) {
            if (targetPnJid === jid) {
                nama = 'Kontak Pribadi (LID)';
            } else {
                nama = '+' + nomorAsli;
            }
        } else {
            nama = '+' + nomorAsli;
        }
    } else {
        dbConfig.kontak[targetPnJid] = nama;
        if (isLid) dbConfig.kontak[jid] = nama;
    }

    let isRahasia = false;
    if (targetPnJid === jid) {
        if (isLid) isRahasia = true;
    }

    return { 
        nama: nama, 
        nomor: isRahasia ? 'Disembunyikan (LID)' : nomorAsli, 
        isLid: isLid, 
        isGrup: isGrup,
        pnJid: targetPnJid
    };
}

async function prosesProtokolPesan(protoMsg, jidPelaku) {
    if (!protoMsg) return;
    if (!protoMsg.key) return;
    if (!protoMsg.key.id) return;

    const idTarget = protoMsg.key.id;
    const jidChat = protoMsg.key.remoteJid;
    
    let isHapus = false;
    if (protoMsg.type === 0) isHapus = true;
    if (protoMsg.type === 'REVOKE') isHapus = true;

    let isEdit = false;
    if (protoMsg.type === 14) isEdit = true;
    if (protoMsg.type === 'MESSAGE_EDIT') isEdit = true;

    if (!isHapus) {
        if (!isEdit) return;
    }

    const dedupKey = (isHapus ? 'hapus' : 'edit') + '-' + idTarget;
    if (cacheDedupProtokol.has(dedupKey)) return; 
    cacheDedupProtokol.set(dedupKey, true);

    if (!dbConfig.topik[jidChat]) return; 

    const dataAsli = cacheAntiDelete.get(idTarget);
    
    let namaPengirim = dataAsli?.pengirim;
    if (!namaPengirim) {
        if (jidPelaku) namaPengirim = ambilInfoKontak(jidPelaku, null).nama;
        else namaPengirim = ambilInfoKontak(jidChat, null).nama;
    }

    let tgMsgIdAsli = cacheWaMsgToTg.get(idTarget);
    if (!tgMsgIdAsli) {
        const temp = msgMapCache.get(idTarget);
        if (temp) tgMsgIdAsli = temp.tgMsgId;
    }
    
    const threadIdChat = dbConfig.topik[jidChat];
    const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');
    
    let linkAsli = '';
    if (tgMsgIdAsli) {
        if (threadIdChat) {
            linkAsli = `\n🔗 [Lihat pesan asli](https://t.me/c/${groupIdBersih}/${threadIdChat}/${tgMsgIdAsli})`;
        }
    }

    let note;
    if (isHapus) {
        let isiHapus = "(media, isi tidak tercatat)";
        if (dataAsli) {
            if (dataAsli.teks) isiHapus = dataAsli.teks;
        }
        note = `🗑️ *Pesan Dihapus*\n👤 Dari: ${namaPengirim}\n💬 Isi pesan: "${isiHapus}"${linkAsli}`;
    } else {
        let teksBaru = protoMsg.editedMessage?.conversation;
        if (!teksBaru) teksBaru = protoMsg.editedMessage?.extendedTextMessage?.text;
        if (!teksBaru) teksBaru = '(media/tidak terbaca)';

        let isiLama = "(tidak tercatat)";
        if (dataAsli) {
            if (dataAsli.teks) isiLama = dataAsli.teks;
        }
        note = `✏️ *Pesan Diedit*\n👤 Dari: ${namaPengirim}\n📝 Sebelum: "${isiLama}"\n📝 Sesudah: "${teksBaru}"${linkAsli}`;
        
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
    
    if (isGrup) {
        if (globalSock) {
            try {
                const meta = await Promise.race([
                    globalSock.groupMetadata(jid),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Get Metadata')), 5000))
                ]);

                if (meta) {
                    if (meta.subject) dbConfig.kontak[jid] = meta.subject;
                }
                
                if (meta) {
                    if (meta.participants) {
                        let changed = false;
                        for (const p of meta.participants) {
                            if (p.lid) {
                                if (p.id) {
                                    if (!dbConfig.lidMap[p.lid]) {
                                        dbConfig.lidMap[p.lid] = p.id;
                                        changed = true;
                                        if (dbConfig.topik[p.lid]) {
                                            let namaTujuan = dbConfig.kontak[p.lid];
                                            if (!namaTujuan) namaTujuan = dbConfig.kontak[p.id];
                                            if (!namaTujuan) namaTujuan = p.id.split('@')[0];
                                            await renameTopikJikaPerlu(p.lid, namaTujuan, false);
                                        }
                                    }
                                }
                            }
                        }
                        if (changed) await simpanKonfigurasiDB();
                    }
                }
            } catch (e) {
                console.log(`[GROUP METADATA SKIP] Timeout/Gagal ambil meta grup ${jid}:`, e.message);
            }
        }
    }

    const info = ambilInfoKontak(jid, pushName);
    let namaFolder = info.isGrup ? '👥 GRUP: ' + info.nama : '👤 ' + info.nama;
    if (info.nomor !== 'Disembunyikan (LID)') {
        if (!info.isGrup) {
            namaFolder += ' (' + info.nomor + ')';
        }
    }
    namaFolder = namaFolder.substring(0, 127);

    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) {
        console.error(`[TG TOPIK GAGAL] Tidak bisa membuat topik untuk ${jid}`);
        return null;
    }

    dbConfig.topik[jid] = result.message_thread_id;

    if (!info.isGrup) {
        const displayNum = info.nomor === 'Disembunyikan (LID)' ? 'Nomor Disembunyikan (LID)' : `+${info.nomor}`;
        const infoMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID,
            `ℹ️ *INFO KONTAK*\nNama: ${info.nama}\nNomor:${displayNum}\nStatus: 🔴 Offline`,
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
    await simpanKonfigurasiDB();

    const threadId = dbConfig.topik[jid];
    if (!threadId) return;

    let namaTopikBaru = isGrup ? '👥 GRUP: ' + namaBaru : '👤 ' + namaBaru;
    const info = ambilInfoKontak(jid, null);
    if (info.nomor !== 'Disembunyikan (LID)') {
        if (!isGrup) {
            namaTopikBaru += ' (' + info.nomor + ')';
        }
    }

    try {
        await tgBot.editForumTopic(TG_GROUP_ID, threadId, { name: namaTopikBaru.substring(0, 127) });
    } catch (e) {}
}

// =========================================================================
// STATUS COMMAND CENTER
// =========================================================================
async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    let diamSaja = false;
    if (!paksa) {
        if (statusHpSaatIni === statusBaru) {
            if (dbConfig.pinned_status_msg_id) {
                if (antreanPesan.length === 0) {
                    if (antreanStatus.length === 0) {
                        if (!sedangSinkronisasi) {
                            diamSaja = true;
                        }
                    }
                }
            }
        }
    }
    if (diamSaja) return;

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
    if (msg.chat.id.toString() !== TG_GROUP_ID) return;
    if (msg.from.is_bot) return;

    const threadId = msg.message_thread_id;
    let targetJid = undefined;
    for (const key of Object.keys(dbConfig.topik)) {
        if (dbConfig.topik[key] === threadId) {
            targetJid = key;
            break;
        }
    }

    let teks = msg.text;
    if (!teks) teks = msg.caption;
    if (!teks) teks = '';
    
    const args = teks.split(' ');
    let cmd = args[0].split('@')[0];
    cmd = cmd.toLowerCase();

    const jadwalkanHapusPerintah = (idBalasan) => {
        if (!cmd.startsWith('/')) return; 
        setTimeout(async () => {
            try { await tgBot.deleteMessage(TG_GROUP_ID, msg.message_id); } catch (e) {}
            if (idBalasan) { try { await tgBot.deleteMessage(TG_GROUP_ID, idBalasan); } catch (e) {} }
        }, DURASI_AUTO_HAPUS_PERINTAH);
    };
    
    const balasPerintah = async (teksBalasan, opts = {}) => {
        const hasil = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, teksBalasan, { message_thread_id: threadId, ...opts }));
        let msgIdBalsan = null;
        if (hasil) {
            if (hasil.message_id) msgIdBalsan = hasil.message_id;
        }
        jadwalkanHapusPerintah(msgIdBalsan);
        return hasil;
    };

    if (cmd === '/help') {
        const help = `🛠️ *MENU COMMAND*\n\n*Umum* (di 📌 Perintah Bot):\n/status - Diagnostik server\n/stealth [on/off] - Mode hantu\n/setmedia [MB] - Set batas media\n/mystatus - Laporan viewer status Anda\n/online - Status online semua kontak\n/restart - Restart bot\n/login [nomor] - Tautkan nomor WA\n\n*Kata Kunci*:\n/addkata, /listkata, /delkata, /blacklistkata, /unblacklistkata\n\n*Status WA*:\n/nostatus, /yesstatus, /liststatus\n\n*Topik Kontak*:\n/info, /mute, /unmute, /hapustopik\n\n*Lainnya*:\n/hapussemuatopik konfirmasi - Hapus semua topik\n\n💬 Ketik langsung di topik untuk kirim pesan. Pakai Reply Telegram untuk membalas pesan spesifik.`;
        return balasPerintah(help, { parse_mode: 'Markdown' });
    }

    if (cmd === '/mystatus') {
        const keys = statusMemory.keys();
        let myStatuses = [];
        for (const k of keys) {
            const stat = statusMemory.get(k);
            if (stat) {
                if (stat.isMyOwn) myStatuses.push(stat);
            }
        }
        if (myStatuses.length === 0) return balasPerintah(`⚠️ Belum ada status Anda yang tersimpan di memori (24 jam terakhir).`);
        
        let replyText = `📱 *LAPORAN STATUS ANDA*\n\n`;
        myStatuses.forEach((stat, i) => {
            let teksPendek = '[Media]';
            if (stat.teks) {
                if (stat.teks.length > 35) {
                    teksPendek = stat.teks.substring(0, 35) + '...';
                } else {
                    teksPendek = stat.teks;
                }
            }
            
            let jmlAudience = '?';
            if (stat.audience) {
                if (stat.audience.length) jmlAudience = stat.audience.length;
            }

            replyText += `*${i+1}.* _${teksPendek}_\n👥 Izin: ${jmlAudience} kontak | 👀 Viewer: ${stat.viewers.length}\n\n`;
        });
        return balasPerintah(replyText, { parse_mode: 'Markdown' });
    }

    if (cmd === '/stealth') {
        let arg = '';
        if (args[1]) arg = args[1];
        arg = arg.toLowerCase();
        
        if (arg === 'on') {
            dbConfig.stealthMode = true;
            if (globalSock) {
                try { await globalSock.sendPresenceUpdate('unavailable'); } catch (e) {}
            }
        } else if (arg === 'off') {
            dbConfig.stealthMode = false;
        } else {
            return balasPerintah(`⚠️ Format: \`/stealth on\` / \`/stealth off\``, { parse_mode: 'Markdown' });
        }
        await simpanKonfigurasiDB();
        perbaruiStatusTelegram(statusHpSaatIni, true);
        return balasPerintah(`✅ Mode Stealth: *${dbConfig.stealthMode ? 'AKTIF' : 'NONAKTIF'}*`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/setmedia') {
        const mb = parseInt(args[1], 10);
        if (isNaN(mb)) return balasPerintah(`⚠️ Ketik: \`/setmedia 100\``, { parse_mode: 'Markdown' });
        if (mb <= 0) return balasPerintah(`⚠️ Ketik: \`/setmedia 100\``, { parse_mode: 'Markdown' });

        dbConfig.maxMediaMB = mb;
        await simpanKonfigurasiDB();
        perbaruiStatusTelegram(statusHpSaatIni, true);
        return balasPerintah(`✅ Batas media diperbarui: *${mb} MB*`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/info') {
        if (!targetJid) return balasPerintah(`⚠️ Jalankan di dalam topik kontak.`);
        const info = ambilInfoKontak(targetJid, null);
        let ketLid = '';
        if (info.nomor === 'Disembunyikan (LID)') ketLid = '\n_(Komunitas/Saluran WA)_';
        
        let statusOnline = currentStatusMap[targetJid];
        if (!statusOnline) statusOnline = '❔ Belum diketahui';
        
        let terakhirTerlihat = '';
        if (statusOnline === '🔴 Offline') {
            if (lastSeenMap[targetJid]) terakhirTerlihat = `\n🕒 Terakhir terlihat: ${waktuLokal(new Date(lastSeenMap[targetJid]))}`;
        }

        let bio = '';
        if (!info.isGrup) {
            if (globalSock) {
                try {
                    let targetBio = info.pnJid;
                    if (!targetBio) targetBio = targetJid;
                    const st = await globalSock.fetchStatus(targetBio);
                    if (st) {
                        if (st.status) bio = `\n📝 Bio: ${st.status}`;
                    }
                } catch (e) { }
            }
        }

        let idTampil = info.pnJid;
        if (!idTampil) idTampil = targetJid;
        
        let displayNomor = 'LID';
        if (info.nomor !== 'Disembunyikan (LID)') displayNomor = '+' + info.nomor;

        const teksInfo = `ℹ️ *DETAIL KONTAK*\n\n👤 Nama: ${info.nama}\n📞 Nomor: \`${displayNomor}\`\n💬 Tipe: ${info.isGrup ? 'Grup' : 'Pribadi'}\n🟢 Status: ${statusOnline}${terakhirTerlihat}${bio}\n🆔 JID: \`${idTampil}\`${ketLid}`;

        let fotoUrl = null;
        if (globalSock) {
            try { 
                let targetPic = info.pnJid;
                if (!targetPic) targetPic = targetJid;
                fotoUrl = await globalSock.profilePictureUrl(targetPic, 'image'); 
            } catch (e) { }
        }

        let hasil;
        if (fotoUrl) {
            hasil = await safeTG(() => tgBot.sendPhoto(TG_GROUP_ID, fotoUrl, { caption: teksInfo, message_thread_id: threadId, parse_mode: 'Markdown' }));
        } else {
            hasil = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${teksInfo}\n\n_(Tidak ada foto profil / diprivasi)_`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        }
        let idMsgRes = null;
        if (hasil) {
            if (hasil.message_id) idMsgRes = hasil.message_id;
        }
        jadwalkanHapusPerintah(idMsgRes);
        return hasil;
    }

    if (cmd === '/status') {
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        let txtConn = 'Terputus';
        if (globalSock) txtConn = 'Terhubung';
        
        let txtStealth = 'Nonaktif';
        if (dbConfig.stealthMode) txtStealth = 'Aktif';

        return balasPerintah(`📊 RAM: ${ram} MB\n🕶️ Stealth: ${txtStealth}\n🔌 WA: ${txtConn}\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n📦 Antrean: ${antreanPesan.length} msg +${antreanStatus.length} story`);
    }

    if (cmd === '/online') {
        const daftarJid = Object.keys(dbConfig.topik).filter((j) => {
            let ok = true;
            if (j.endsWith('@g.us')) ok = false;
            return ok;
        });
        
        if (daftarJid.length === 0) return balasPerintah(`Belum ada kontak.`);

        const baris = daftarJid.map((j) => {
            const nama = ambilInfoKontak(j, null).nama;
            let st = currentStatusMap[j];
            if (!st) st = '❔ Belum diketahui';
            
            let iconDepan = '🔴';
            if (st === '🟢 Online') {
                iconDepan = '🟢';
            } else if (st.includes('Mengetik')) {
                iconDepan = '🟡';
            } else if (st.includes('Merekam')) {
                iconDepan = '🟡';
            }

            return `${iconDepan} ${nama}`;
        });
        return balasPerintah(`📶 *STATUS ONLINE KONTAK*\n\n${baris.join('\n')}`, { parse_mode: 'Markdown' });
    }

    if (cmd === '/mute' && targetJid) {
        if (!dbConfig.muted.includes(targetJid)) dbConfig.muted.push(targetJid);
        await simpanKonfigurasiDB(); return balasPerintah(`🔇 Topik dibisukan.`);
    }
    if (cmd === '/unmute' && targetJid) {
        dbConfig.muted = dbConfig.muted.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB(); return balasPerintah(`🔊 Topik aktif.`);
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
        let argSatu = args[1];
        if (!argSatu) return balasPerintah(`⚠️ Ketik manual: /hapussemuatopik konfirmasi`);
        if (argSatu.toLowerCase() !== 'konfirmasi') return balasPerintah(`⚠️ Ketik manual: /hapussemuatopik konfirmasi`);
        
        const semuaJid = Object.keys(dbConfig.topik);
        await balasPerintah(`🔄 Menghapus ${semuaJid.length} topik...`);

        let berhasil = 0;
        for (const j of semuaJid) {
            try { await tgBot.deleteForumTopic(TG_GROUP_ID, dbConfig.topik[j]); berhasil++; } catch (e) {}
            await delay(300); 
        }
        dbConfig.topik = {}; dbConfig.topicInfoMsgs = {}; dbConfig.muted = [];
        await simpanKonfigurasiDB();
        try { await replyMapCollection.deleteMany({}); } catch (e) {}
        
        cacheAntiDelete.flushAll();

        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ ${berhasil}/${semuaJid.length} topik terhapus.`));
    }

    if (cmd === '/addkata') {
        const kataBaru = teks.slice(cmd.length).trim();
        if (!kataBaru) return balasPerintah(`⚠️ Ketik: \`/addkata kata1,kata2\``, { parse_mode: 'Markdown' });
        const daftarBaru = kataBaru.split(',').map((k) => k.trim().toLowerCase()).filter((x) => x !== '');
        let ditambah = 0;
        for (const k of daftarBaru) {
            if (!dbConfig.kataKunci.includes(k)) { dbConfig.kataKunci.push(k); ditambah++; }
        }
        await simpanKonfigurasiDB(); return balasPerintah(`✅ ${ditambah} kata kunci ditambahkan.`);
    }
    if (cmd === '/listkata') {
        if (dbConfig.kataKunci.length === 0) return balasPerintah(`Belum ada kata kunci.`);
        const daftar = dbConfig.kataKunci.map((k, i) => `${i + 1}.${k}`).join('\n');
        return balasPerintah(`🔑 *DAFTAR KATA KUNCI*\n\n${daftar}\n\nHapus dgn: /delkata [nomor]`, { parse_mode: 'Markdown' });
    }
    if (cmd === '/delkata') {
        const idx = parseInt(args[1], 10) - 1;
        if (isNaN(idx)) return balasPerintah(`⚠️ Nomor tidak valid.`);
        if (!dbConfig.kataKunci[idx]) return balasPerintah(`⚠️ Nomor tidak valid.`);
        const dihapus = dbConfig.kataKunci.splice(idx, 1);
        await simpanKonfigurasiDB(); return balasPerintah(`✅ "${dihapus[0]}" dihapus.`);
    }
    if (cmd === '/blacklistkata' && targetJid) {
        if (!dbConfig.blacklistKataKunci.includes(targetJid)) dbConfig.blacklistKataKunci.push(targetJid);
        await simpanKonfigurasiDB(); return balasPerintah(`✅ Blacklist kata kunci aktif.`);
    }
    if (cmd === '/unblacklistkata' && targetJid) {
        dbConfig.blacklistKataKunci = dbConfig.blacklistKataKunci.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB(); return balasPerintah(`✅ Blacklist dicabut.`);
    }

    if (cmd === '/nostatus' && targetJid) {
        if (!dbConfig.blacklistStatus.includes(targetJid)) dbConfig.blacklistStatus.push(targetJid);
        await simpanKonfigurasiDB(); return balasPerintah(`✅ Status tidak diunduh.`);
    }
    if (cmd === '/yesstatus' && targetJid) {
        dbConfig.blacklistStatus = dbConfig.blacklistStatus.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB(); return balasPerintah(`✅ Status akan diunduh lagi.`);
    }

    if (cmd === '/login') {
        let nomor = args[1];
        if (!nomor) return balasPerintah(`⚠️ Format: \`/login 628123456789\``, { parse_mode: 'Markdown' });
        nomor = nomor.replace(/[^0-9]/g, '');
        if (!nomor) return balasPerintah(`⚠️ Format: \`/login 628123456789\``, { parse_mode: 'Markdown' });
        if (!globalSock) return balasPerintah(`⚠️ Socket belum siap.`);
        if (globalSock.authState.creds.registered) return balasPerintah(`✅ Sudah login.`);

        dbConfig.nomor_wa_utama = nomor; await simpanKonfigurasiDB();
        try {
            let kode = await globalSock.requestPairingCode(nomor);
            if (kode) {
                const arr = kode.match(/.{1,4}/g);
                if (arr) kode = arr.join('-');
            }
            return balasPerintah(`🔑 *KODE PAIRING:* \`${kode}\``, { parse_mode: 'Markdown' });
        } catch (e) { return balasPerintah(`❌ Gagal: ${e.message}`); }
    }

    if (cmd === '/restart') {
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔄 Merestart bot...`, { message_thread_id: threadId }));
        try { if (globalSock) globalSock.end(undefined); } catch (e) {}
        try { await mongoClient.close(); } catch (e) {}
        await delay(1000); process.exit(0);
    }

    let isCmdContactOnly = false;
    if (cmd === '/info') isCmdContactOnly = true;
    if (cmd === '/mute') isCmdContactOnly = true;
    if (cmd === '/unmute') isCmdContactOnly = true;
    if (cmd === '/hapustopik') isCmdContactOnly = true;
    if (cmd === '/blacklistkata') isCmdContactOnly = true;
    if (cmd === '/unblacklistkata') isCmdContactOnly = true;
    if (cmd === '/nostatus') isCmdContactOnly = true;
    if (cmd === '/yesstatus') isCmdContactOnly = true;

    if (teks.startsWith('/')) {
        if (isCmdContactOnly) {
            if (!targetJid) {
                return balasPerintah(`⚠️ Jalankan perintah ini di DALAM topik kontak.`);
            }
        }
    }

    let teksTrim = teks.trim();
    if (!targetJid) {
        if (threadId) {
            if (!teks.startsWith('/')) {
                if (teksTrim !== '') {
                    let isSysTopic = false;
                    for (const v of Object.values(dbConfig.sysTopics)) {
                        if (v === threadId) {
                            isSysTopic = true;
                            break;
                        }
                    }
                    if (!isSysTopic) {
                        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Topik tidak terhubung ke WA.`, { message_thread_id: threadId }));
                    }
                }
            }
        }
    }

    if (!targetJid) {
        if (!threadId) {
            if (!teks.startsWith('/')) {
                if (teksTrim !== '') return;
            }
        }
    }

    // ---- BALAS KE WA (teks & media) DARI TELEGRAM ----
    if (targetJid) {
        if (globalSock) {
            if (!teks.startsWith('/')) {
                
                // [STEALTH] HANYA kirim composing jika mode stealth tidak aktif
                if (!dbConfig.stealthMode) {
                    try {
                        await globalSock.sendPresenceUpdate('composing', targetJid);
                        await delay(1200);
                        await globalSock.sendPresenceUpdate('paused', targetJid);
                    } catch (e) {}
                }

                let msgOptions = { text: teks };
                
                let hasMedia = false;
                if (msg.photo) hasMedia = true;
                if (msg.video) hasMedia = true;
                if (msg.document) hasMedia = true;
                if (msg.audio) hasMedia = true;
                if (msg.voice) hasMedia = true;

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
                        const bufArr = await response.arrayBuffer();
                        const buffer = Buffer.from(bufArr);

                        if (msg.photo) {
                            msgOptions = { image: buffer, caption: teks };
                        } else if (msg.video) {
                            msgOptions = { video: buffer, caption: teks };
                        } else if (msg.document) {
                            let mType = msg.document.mime_type;
                            if (!mType) mType = 'application/octet-stream';
                            let fName = msg.document.file_name;
                            if (!fName) fName = 'document';
                            msgOptions = { document: buffer, mimetype: mType, fileName: fName, caption: teks };
                        } else if (msg.audio) {
                            msgOptions = { audio: buffer, mimetype: 'audio/mp4', ptt: false };
                        } else if (msg.voice) {
                            msgOptions = { audio: buffer, mimetype: 'audio/mp4', ptt: true };
                        }
                    }

                    let opsiKirim;
                    if (msg.reply_to_message) {
                        const target = await ambilPemetaanReply(msg.reply_to_message.message_id);
                        if (target) {
                            if (target.waJid === targetJid) {
                                opsiKirim = { quoted: target.waMsg };
                            }
                        }
                    }

                    const sent = await globalSock.sendMessage(targetJid, msgOptions, opsiKirim);
                    msgMapCache.set(sent.key.id, { tgMsgId: msg.message_id, threadId: threadId });

                    // [STEALTH] Menghilangkan jejak status online setelah membalas
                    if (dbConfig.stealthMode) {
                        try { await globalSock.sendPresenceUpdate('unavailable'); } catch (e) {}
                    }
                } catch (e) {
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal kirim: ${e.message}`, { message_thread_id: threadId }));
                }
            }
        }
    }
});

tgBot.on('message_reaction', async (reaction) => {
    if (reaction.chat.id.toString() !== TG_GROUP_ID) return;
    if (!globalSock) return;
    
    const target = await ambilPemetaanReply(reaction.message_id);
    if (!target) return;

    let emojiBaru = '';
    if (reaction.new_reaction) {
        const found = reaction.new_reaction.find((r) => r.type === 'emoji');
        if (found) {
            if (found.emoji) emojiBaru = found.emoji;
        }
    }
    
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
        while (true) {
            let adaPesan = false;
            if (antreanPesan.length > 0) adaPesan = true;
            
            let adaStatus = false;
            if (antreanStatus.length > 0) adaStatus = true;
            
            if (!adaPesan) {
                if (!adaStatus) {
                    break;
                }
            }

            if (adaPesan) {
                let targetIdx = antreanPesan.findIndex(p => !p.isHistory);
                if (targetIdx === -1) targetIdx = 0;

                const taskArr = antreanPesan.splice(targetIdx, 1);
                const task = taskArr[0];

                try {
                    await withTimeout(eksekusiKirimKeTelegram(task.infoPesan, task.pushName, task.isHistory, task.isFromMe), 90000, 'KirimPesan');
                } catch (e) {
                    console.error('[ANTREAN PESAN ERROR] Melewati 1 pesan:', e.message);
                }
                
                if (antreanPesan.length % 10 === 0) perbaruiStatusTelegram(statusHpSaatIni);
                
                let wTime = 500;
                if (task.isHistory) wTime = 1000;
                await delay(wTime); 
            } else {
                const infoStatus = antreanStatus.shift();
                try {
                    await withTimeout(prosesStatusBroadcast(infoStatus), 60000, 'KirimStatus');
                } catch (e) {
                    console.error('[ANTREAN STATUS ERROR]', e.message);
                }
                await delay(800);
            }
            
            let doGc = false;
            if (global.gc) {
                if ((antreanPesan.length + antreanStatus.length) % 20 === 0) {
                    doGc = true;
                }
            }
            if (doGc) global.gc();
        }
    } finally {
        sedangMemprosesAntrean = false;
        perbaruiStatusTelegram(statusHpSaatIni);
    }
}

// =========================================================================
// EKSTRAKSI & PENGIRIMAN MEDIA NATIVE (Foto/Video/Audio/Dokumen)
// =========================================================================
async function prosesStatusBroadcast(infoPesan) {
    const isMyOwn = infoPesan.key.fromMe;
    let statusMsg = infoPesan.message;
    if (statusMsg) {
        if (statusMsg.ephemeralMessage) statusMsg = statusMsg.ephemeralMessage.message;
    }
    
    if (!statusMsg) return;

    const infoPembuat = isMyOwn ? { nama: 'ANDA SENDIRI' } : ambilInfoKontak(infoPesan.key.participant, infoPesan.pushName);
    
    let teksKonten = statusMsg.conversation;
    if (!teksKonten) teksKonten = statusMsg.extendedTextMessage?.text;
    if (!teksKonten) teksKonten = '';

    let pesanMedia = statusMsg.imageMessage;
    if (!pesanMedia) pesanMedia = statusMsg.videoMessage;

    let contextInfo = statusMsg.extendedTextMessage?.contextInfo;
    if (!contextInfo) contextInfo = statusMsg.imageMessage?.contextInfo;
    if (!contextInfo) contextInfo = statusMsg.videoMessage?.contextInfo;
    if (!contextInfo) contextInfo = infoPesan.contextInfo;

    let statusJidList = contextInfo?.statusJidList;
    if (!statusJidList) statusJidList = contextInfo?.bcastJidList;
    if (!statusJidList) statusJidList = [];
    
    statusMemory.set(infoPesan.key.id, { 
        teks: teksKonten, 
        media: !!pesanMedia, 
        audience: statusJidList, 
        viewers: [],
        isMyOwn: isMyOwn
    });
    
    let privasiInfo = '';
    if (isMyOwn) {
        if (statusJidList.length > 0) {
            privasiInfo = `\n🔒 _Status ini diizinkan untuk ${statusJidList.length} kontak_`;
        } else {
            privasiInfo = `\n🔒 _Daftar izin kontak tidak terbaca_`;
        }
    }

    const caption = `📱 *Status: ${infoPembuat.nama}*\n${teksKonten}${privasiInfo}`;

    try {
        let hasilStatus;
        if (pesanMedia) {
            let tipeUnduh = 'video';
            if (statusMsg.imageMessage) tipeUnduh = 'image';

            const stream = await downloadContentFromMessage(pesanMedia, tipeUnduh);
            let buffer = Buffer.alloc(0);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            
            const tgOpts = { caption: caption, parse_mode: 'Markdown' };
            
            if (tipeUnduh === 'image') {
                hasilStatus = await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => 
                    tgBot.sendPhoto(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, { filename: 'status.jpg', contentType: 'image/jpeg' })
                );
            } else {
                hasilStatus = await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => 
                    tgBot.sendVideo(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, { filename: 'status.mp4', contentType: 'video/mp4' })
                );
            }
            if (global.gc) global.gc();
        } else {
            hasilStatus = await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, caption, { message_thread_id: tId, parse_mode: 'Markdown' }));
        }
        if (hasilStatus) {
            if (hasilStatus.message_id) cacheWaMsgToTg.set(infoPesan.key.id, hasilStatus.message_id);
        }
    } catch (e) { console.error('[STATUS ERROR]', e.message); }

    if (isMyOwn) {
        if (statusJidList.length > 0) {
            await delay(800);
            const daftarPenerima = statusJidList.map((j) => '- ' + ambilInfoKontak(j, null).nama);
            for (let i = 0; i < daftarPenerima.length; i += 100) {
                const listStr = daftarPenerima.slice(i, i + 100).join('\n');
                await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👥 *Diizinkan Melihat Status Ini:*\n\n${listStr}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
                await delay(500);
            }
        }
    }
}

async function eksekusiKirimKeTelegram(infoPesan, pushName, isHistory, isFromMe = false) {
    const idPengirim = infoPesan.key.remoteJid;
    if (dbConfig.muted.includes(idPengirim)) return;

    let threadIdTarget = null;
    try {
        threadIdTarget = await pastikanTopik(idPengirim, pushName);
    } catch (e) {
        console.error('[TOPIK GAGAL FATAL]', e.message);
    }

    const kirim = async (fn) => {
        let hasil = null;
        if (threadIdTarget) hasil = await kirimKeTopik({ jid: idPengirim }, fn);
        else hasil = await kirimKeTopik({ sysKey: 'audit' }, fn); 

        if (hasil) {
            if (hasil.message_id) {
                if (threadIdTarget) {
                    simpanPemetaanReply(hasil.message_id, { waJid: idPengirim, waMsg: { key: infoPesan.key, message: infoPesan.message } });
                    cacheWaMsgToTg.set(infoPesan.key.id, hasil.message_id);
                }
            }
        }
        return hasil;
    };
    
    let awalan = '';
    if (isHistory) awalan = '🕰️ [Riwayat] ';

    let isiPesan = infoPesan.message;
    if (isiPesan) {
        if (isiPesan.ephemeralMessage) isiPesan = isiPesan.ephemeralMessage.message;
    }
    if (isiPesan) {
        if (isiPesan.documentWithCaptionMessage) isiPesan = isiPesan.documentWithCaptionMessage.message;
    }
    
    if (!isiPesan) return; 

    let isViewOnce = false;
    if (isiPesan.viewOnceMessage) { 
        isViewOnce = true; 
        isiPesan = isiPesan.viewOnceMessage.message; 
    } else if (isiPesan.viewOnceMessageV2) { 
        isViewOnce = true; 
        isiPesan = isiPesan.viewOnceMessageV2.message; 
    } else if (isiPesan.viewOnceMessageV2Extension) { 
        isViewOnce = true; 
        isiPesan = isiPesan.viewOnceMessageV2Extension.message; 
    }

    let adaViewOnceLagi = false;
    if (isiPesan.imageMessage) {
        if (isiPesan.imageMessage.viewOnce) adaViewOnceLagi = true;
    }
    if (isiPesan.videoMessage) {
        if (isiPesan.videoMessage.viewOnce) adaViewOnceLagi = true;
    }
    if (isiPesan.audioMessage) {
        if (isiPesan.audioMessage.viewOnce) adaViewOnceLagi = true;
    }
    if (adaViewOnceLagi) isViewOnce = true;

    const tipePesan = Object.keys(isiPesan).find((k) => {
        let ok = true;
        if (k === 'senderKeyDistributionMessage') ok = false;
        if (k === 'messageContextInfo') ok = false;
        return ok;
    });

    if (!tipePesan) return;

    const infoUtama = ambilInfoKontak(idPengirim, pushName);
    
    let infoPengirimAsli = infoUtama;
    if (infoUtama.isGrup) {
        if (infoPesan.key.participant) {
            infoPengirimAsli = ambilInfoKontak(infoPesan.key.participant, infoPesan.pushName);
        }
    }
    
    let namaPengirimFinal = infoPengirimAsli.nama;
    if (isFromMe) namaPengirimFinal = 'Anda';

    let prefixArah = '';
    if (isFromMe) {
        prefixArah = `📤 *Anda:*\n`;
    } else {
        if (infoUtama.isGrup) {
            prefixArah = `👤 *[${infoPengirimAsli.nama}]*:\n`;
        }
    }

    if (isiPesan.reactionMessage) {
        let emoji = isiPesan.reactionMessage.text;
        if (!emoji) emoji = '';
        const targetId = isiPesan.reactionMessage.key.id;
        
        const statMem = statusMemory.get(targetId);
        if (statMem) {
            if (statMem.isMyOwn) {
                let labelEmoji = emoji;
                if (!labelEmoji) labelEmoji = '(mencabut reaksi)';
                let txtStat = statMem.teks;
                if (!txtStat) txtStat = 'Media';

                await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}🌟 *[Reaksi ${labelEmoji} dari ${namaPengirimFinal}]* pada status Anda:\n👉 _"${txtStat}"_`, { message_thread_id: tId, parse_mode: 'Markdown' }));
                return;
            }
        }

        const dataAsli = cacheAntiDelete.get(targetId);
        let tgTargetMsgId = cacheWaMsgToTg.get(targetId);
        if (!tgTargetMsgId) {
            const mData = msgMapCache.get(targetId);
            if (mData) tgTargetMsgId = mData.tgMsgId;
        }

        if (emoji) {
            if (tgTargetMsgId) await setTGReaksi(tgTargetMsgId, emoji);
        }

        let labelEmoji = emoji;
        if (!labelEmoji) labelEmoji = '(dihapus)';
        
        let txtRef = '(pesan/media tidak tercatat)';
        if (dataAsli) {
            if (dataAsli.teks) txtRef = dataAsli.teks;
        }

        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}[Reaksi ${labelEmoji} dari ${namaPengirimFinal}] pada: "_${txtRef}_"`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    if (isViewOnce) {
        let jMedia = 'Media';
        if (isiPesan.imageMessage) jMedia = 'Foto';
        else if (isiPesan.videoMessage) jMedia = 'Video';
        else if (isiPesan.audioMessage) jMedia = 'Pesan Suara';
        
        let waktuStamp = Date.now();
        if (infoPesan.messageTimestamp) waktuStamp = infoPesan.messageTimestamp * 1000;
        const waktuStr = waktuLokal(new Date(waktuStamp));

        const teksVO = `${awalan}👁️ *PESAN SEKALI-LIHAT (${jMedia.toUpperCase()})*\n\n👤 *Dari:* ${namaPengirimFinal}\n🕒 *Waktu:* ${waktuStr}\n\nℹ️ _Sistem keamanan server WhatsApp terbaru telah memblokir pengunduhan jenis pesan ini untuk aplikasi pihak ketiga._`;
        
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

    let isContact = false;
    if (isiPesan.contactMessage) isContact = true;
    if (isiPesan.contactsArrayMessage) isContact = true;

    if (isContact) {
        let daftarKontak = [];
        if (isiPesan.contactMessage) {
            daftarKontak = [isiPesan.contactMessage];
        } else {
            if (isiPesan.contactsArrayMessage.contacts) {
                daftarKontak = isiPesan.contactsArrayMessage.contacts;
            }
        }

        for (const c of daftarKontak) {
            const vc = parseVCard(c.vcard);
            if (vc) {
                if (vc.nama) {
                    for (const nomor of vc.nomorList) {
                        const kemungkinanJid = `${nomor}@s.whatsapp.net`;
                        if (dbConfig.topik[kemungkinanJid]) await renameTopikJikaPerlu(kemungkinanJid, vc.nama, false);
                    }
                }
            }
        }
        
        let msgLabel = `👥 Membagikan ${daftarKontak.length} kontak`;
        if (isiPesan.contactMessage) {
            msgLabel = `👤 Membagikan kontak: *${isiPesan.contactMessage.displayName}*`;
        }
        
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}${prefixArah}${msgLabel}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    let pollMsg = null;
    if (isiPesan.pollCreationMessage) pollMsg = isiPesan.pollCreationMessage;
    if (isiPesan.pollCreationMessageV3) pollMsg = isiPesan.pollCreationMessageV3;

    if (pollMsg) {
        let arrOpsi = [];
        if (pollMsg.options) arrOpsi = pollMsg.options;
        const daftarOpsi = arrOpsi.map((o) => '• ' + o.optionName).join('\n');
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}${prefixArah}📊 *Polling:* ${pollMsg.name}\n${daftarOpsi}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    if (isiPesan.stickerMessage) {
        try {
            if (prefixArah) await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, prefixArah.trim(), { message_thread_id: tId, parse_mode: 'Markdown' }));
            const stream = await downloadContentFromMessage(isiPesan.stickerMessage, 'sticker');
            let buffer = Buffer.alloc(0);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            
            await kirim((tId) => tgBot.sendSticker(TG_GROUP_ID, buffer, { message_thread_id: tId }, { filename: 'sticker.webp', contentType: 'image/webp' }));
            let gcOk = false;
            if (global.gc) gcOk = true;
            if (gcOk) global.gc();
        } catch (e) { console.error('[STIKER ERROR]', e.message); }
        return;
    }

    let teksKonten = isiPesan.conversation;
    if (!teksKonten) teksKonten = isiPesan.extendedTextMessage?.text;
    if (!teksKonten) {
        const tObj = isiPesan[tipePesan];
        if (tObj) {
            if (tObj.caption) teksKonten = tObj.caption;
        }
    }
    if (!teksKonten) teksKonten = '';

    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan, pengirim: namaPengirimFinal, isGrup: infoUtama.isGrup });

    let contextInfo = isiPesan.extendedTextMessage?.contextInfo;
    if (!contextInfo) contextInfo = isiPesan.imageMessage?.contextInfo;
    if (!contextInfo) contextInfo = isiPesan.videoMessage?.contextInfo;
    if (!contextInfo) contextInfo = isiPesan.documentMessage?.contextInfo;
    if (!contextInfo) contextInfo = isiPesan.stickerMessage?.contextInfo;
    if (!contextInfo) contextInfo = isiPesan.audioMessage?.contextInfo;

    let quoteBlock = '';
    
    let botJid = '';
    if (globalSock) {
        if (globalSock.user) {
            if (globalSock.user.id) {
                botJid = globalSock.user.id.split(':')[0] + '@s.whatsapp.net';
            }
        }
    }
    
    const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');

    const buatLinkTelegram = (tId, msgId) => {
        let ok = false;
        if (tId) {
            if (msgId) ok = true;
        }
        if (!ok) return '';
        return `https://t.me/c/${groupIdBersih}/${tId}/${msgId}`;
    };

    const labelKontenQuoted = (qm) => {
        if (!qm) return '[Pesan]';
        if (qm.conversation) return qm.conversation;
        if (qm.extendedTextMessage) {
            if (qm.extendedTextMessage.text) return qm.extendedTextMessage.text;
        }
        if (qm.imageMessage) {
            if (qm.imageMessage.caption) return '[Foto] ' + qm.imageMessage.caption;
            return '[Foto]';
        }
        if (qm.videoMessage) {
            if (qm.videoMessage.caption) return '[Video] ' + qm.videoMessage.caption;
            return '[Video]';
        }
        if (qm.documentMessage) {
            let dName = qm.documentMessage.fileName;
            if (!dName) dName = '';
            return '[Dokumen] ' + dName.trim();
        }
        if (qm.audioMessage) {
            if (qm.audioMessage.ptt) return '[Voice Note]';
            return '[Audio]';
        }
        return '[Media]';
    };

    if (contextInfo) {
        if (contextInfo.quotedMessage) {
            let isQuoteStatus = false;
            if (contextInfo.remoteJid === 'status@broadcast') isQuoteStatus = true;
            
            const labelKonten = labelKontenQuoted(contextInfo.quotedMessage);

            if (isQuoteStatus) {
                const statMem = statusMemory.get(contextInfo.stanzaId);
                let isiStatus = labelKonten;
                if (labelKonten === '[Pesan]') {
                    if (statMem) {
                        if (statMem.teks) isiStatus = statMem.teks;
                        else isiStatus = '[Media Status]';
                    } else {
                        isiStatus = '[Media Status]';
                    }
                }
                
                const linkStatus = buatLinkTelegram(dbConfig.sysTopics.statusWA, cacheWaMsgToTg.get(contextInfo.stanzaId));
                
                let infoAudiens = `\n> ℹ️ _Data audiens/viewer status ini tidak tersimpan_`;
                if (statMem) {
                    let lenAud = '?';
                    if (statMem.audience) lenAud = statMem.audience.length;
                    let lenView = 0;
                    if (statMem.viewers) lenView = statMem.viewers.length;
                    infoAudiens = `\n> 🔒 Diizinkan lihat: ${lenAud} kontak | 👀 Sudah lihat: ${lenView} kontak`;
                }

                let qStr = `> 📝 *Membalas Status`;
                let statIsMine = false;
                if (contextInfo.participant === botJid) statIsMine = true;
                if (statIsMine) qStr += ' Anda';
                qStr += `:*\n> _"${isiStatus}"_`;
                qStr += infoAudiens;
                if (linkStatus) qStr += `\n> 🔗 [Lihat status](${linkStatus})\n\n`;
                else qStr += '\n\n';
                
                quoteBlock = qStr;
            } else {
                let infoPengirimQuoted = null;
                if (contextInfo.participant) {
                    infoPengirimQuoted = ambilInfoKontak(contextInfo.participant, null);
                }
                let labelPengirim = namaPengirimFinal;
                if (infoPengirimQuoted) labelPengirim = infoPengirimQuoted.nama;
                
                const linkQuoted = buatLinkTelegram(dbConfig.topik[idPengirim], cacheWaMsgToTg.get(contextInfo.stanzaId));
                
                let qStr = `> 📝 *Membalas ${labelPengirim}:*\n> _${labelKonten}_\n`;
                if (linkQuoted) qStr += `> 🔗 [Lihat pesan asli](${linkQuoted})\n\n`;
                else qStr += '\n';

                quoteBlock = qStr;
            }
        }
    }

    let mentionedList = [];
    if (contextInfo) {
        if (contextInfo.mentionedJid) mentionedList = contextInfo.mentionedJid;
    }
    
    let isMentioned = false;
    if (mentionedList.includes(botJid)) isMentioned = true;

    let isReplyToMe = false;
    if (contextInfo) {
        if (contextInfo.participant === botJid) {
            if (!isFromMe) isReplyToMe = true;
        }
    }

    let tagNotice = '';

    if (isMentioned) {
        const namaList = mentionedList.map((j) => ambilInfoKontak(j, null).nama).join(', ');
        tagNotice += `🔖 *Men-tag:* ${namaList}\n🔔 *[ANDA DI-MENTION]*\n\n`;
    } else if (isReplyToMe) {
        tagNotice += `🔔 *[PESAN ANDA DIBALAS]*\n\n`;
    } else if (mentionedList.length > 0) {
        const namaList = mentionedList.map((j) => ambilInfoKontak(j, null).nama).join(', ');
        tagNotice += `🔖 *Men-tag:* ${namaList}\n\n`;
    }

    let pesanMedia = isiPesan.imageMessage;
    if (!pesanMedia) pesanMedia = isiPesan.videoMessage;
    if (!pesanMedia) pesanMedia = isiPesan.documentMessage;
    if (!pesanMedia) pesanMedia = isiPesan.audioMessage;
    if (!pesanMedia) pesanMedia = isiPesan.ptvMessage;
    
    try {
        if (pesanMedia) {
            let ukuranBytes = 0;
            if (pesanMedia.fileLength) ukuranBytes = parseInt(pesanMedia.fileLength, 10);
            
            const batasBytes = dbConfig.maxMediaMB * 1024 * 1024;
            let skipBesar = false;
            if (ukuranBytes > batasBytes) skipBesar = true;

            if (skipBesar) {
                const mathMb = Math.round(ukuranBytes/1024/1024);
                const fallbackGagalBesar = `⚠️ [Media ${mathMb}MB dilewati (Batas: ${dbConfig.maxMediaMB}MB)]`;
                const tBlock = `${tagNotice}${awalan}${prefixArah}${quoteBlock}${fallbackGagalBesar}\n💬 ${teksKonten}`;
                const hasilKirim = await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, tBlock, { message_thread_id: tId, parse_mode: 'Markdown' }));
                
                let tKontenF = teksKonten;
                if (!tKontenF) tKontenF = '[Media Besar]';

                await notifikasiMentionDiri(isMentioned, isReplyToMe, idPengirim, hasilKirim, infoUtama, tKontenF);
                return;
            }
            
            let tipeUnduh = '';
            let namaFileFinal = `media_${infoPesan.key.id}`;
            let mimeTypeFinal = 'application/octet-stream';

            if (isiPesan.imageMessage) {
                tipeUnduh = 'image';
                namaFileFinal = `foto_${infoPesan.key.id}.jpg`;
                if (isiPesan.imageMessage.mimetype) mimeTypeFinal = isiPesan.imageMessage.mimetype;
                else mimeTypeFinal = 'image/jpeg';
            } else if (isiPesan.videoMessage) {
                tipeUnduh = 'video';
                namaFileFinal = `video_${infoPesan.key.id}.mp4`;
                if (isiPesan.videoMessage.mimetype) mimeTypeFinal = isiPesan.videoMessage.mimetype;
                else mimeTypeFinal = 'video/mp4';
            } else if (isiPesan.ptvMessage) {
                tipeUnduh = 'video';
                namaFileFinal = `video_${infoPesan.key.id}.mp4`;
                if (isiPesan.ptvMessage.mimetype) mimeTypeFinal = isiPesan.ptvMessage.mimetype;
                else mimeTypeFinal = 'video/mp4';
            } else if (isiPesan.documentMessage) {
                tipeUnduh = 'document';
                if (isiPesan.documentMessage.fileName) namaFileFinal = isiPesan.documentMessage.fileName;
                else namaFileFinal = `dokumen_${infoPesan.key.id}`;
                if (isiPesan.documentMessage.mimetype) mimeTypeFinal = isiPesan.documentMessage.mimetype;
                else mimeTypeFinal = 'application/octet-stream';
            } else if (isiPesan.audioMessage) {
                tipeUnduh = 'audio';
                const isPTT = isiPesan.audioMessage.ptt;
                namaFileFinal = `audio_${infoPesan.key.id}.${isPTT ? 'ogg' : 'mp3'}`;
                if (isiPesan.audioMessage.mimetype) mimeTypeFinal = isiPesan.audioMessage.mimetype;
                else {
                    if (isPTT) mimeTypeFinal = 'audio/ogg';
                    else mimeTypeFinal = 'audio/mpeg';
                }
            }

            try {
                const teksCaption = `${tagNotice}${awalan}${prefixArah}${quoteBlock}${teksKonten}`;
                const tgOpts = { caption: teksCaption, parse_mode: 'Markdown' };
                const fileOpts = { filename: namaFileFinal, contentType: mimeTypeFinal };

                let hasilKirim;
                
                let isMediaRaksasa = false;
                if (ukuranBytes > 49 * 1024 * 1024) isMediaRaksasa = true;

                if (isMediaRaksasa) {
                    while (isUploadingBigFile) { 
                        await delay(2000); 
                    }
                    isUploadingBigFile = true;
                    
                    const tempFilePath = path.join(os.tmpdir(), namaFileFinal);
                    let notifTunggu = null;

                    try {
                        const mBytes = Math.round(ukuranBytes / 1024 / 1024);
                        notifTunggu = await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `⏳ *Mengunduh file raksasa dari WhatsApp...* (${mBytes} MB)`, { message_thread_id: tId, parse_mode: 'Markdown' }));

                        const writeStream = fs.createWriteStream(tempFilePath);
                        const stream = await downloadContentFromMessage(pesanMedia, tipeUnduh);

                        await new Promise((resolve, reject) => {
                            stream.on('data', (chunk) => writeStream.write(chunk));
                            stream.on('end', () => writeStream.end());
                            writeStream.on('finish', resolve);
                            writeStream.on('error', reject);
                            stream.on('error', reject);
                        });

                        const cekUkuranFisik = fs.statSync(tempFilePath).size;
                        const cMb = Math.round(cekUkuranFisik / 1024 / 1024);
                        
                        if (notifTunggu) {
                            await safeTG(() => tgBot.editMessageText(`🚀 *Meneruskan file (${cMb} MB) ke Telegram via MTProto...*`, { 
                                chat_id: TG_GROUP_ID, 
                                message_id: notifTunggu.message_id, 
                                parse_mode: 'Markdown' 
                            }));
                        }

                        let targetThreadId = dbConfig.sysTopics.audit;
                        if (threadIdTarget) targetThreadId = threadIdTarget;
                        
                        hasilKirim = await uploadBesarMTProto(tempFilePath, namaFileFinal, mimeTypeFinal, teksCaption, TG_GROUP_ID, targetThreadId);

                        if (hasilKirim) {
                            if (hasilKirim.message_id) {
                                if (threadIdTarget) {
                                    simpanPemetaanReply(hasilKirim.message_id, { waJid: idPengirim, waMsg: { key: infoPesan.key, message: infoPesan.message } });
                                    cacheWaMsgToTg.set(infoPesan.key.id, hasilKirim.message_id);
                                }
                            }
                        }

                        if (notifTunggu) {
                            await safeTG(() => tgBot.deleteMessage(TG_GROUP_ID, notifTunggu.message_id).catch(() => {}));
                        }
                    } catch (uploadErr) {
                        if (notifTunggu) {
                            await safeTG(() => tgBot.editMessageText(`❌ *Gagal mengunggah media besar:* ${uploadErr.message}`, {
                                chat_id: TG_GROUP_ID,
                                message_id: notifTunggu.message_id,
                                parse_mode: 'Markdown'
                            }));
                        }
                    } finally {
                        if (fs.existsSync(tempFilePath)) {
                            try { fs.unlinkSync(tempFilePath); } catch (e) {}
                        }
                        isUploadingBigFile = false;
                        let gOk = false;
                        if (global.gc) gOk = true;
                        if (gOk) global.gc();
                    }
                } else {
                    const stream = await downloadContentFromMessage(pesanMedia, tipeUnduh);
                    let buffer = Buffer.alloc(0);
                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                    if (tipeUnduh === 'image') {
                        hasilKirim = await kirim((tId) => tgBot.sendPhoto(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, fileOpts));
                    } else if (tipeUnduh === 'video') {
                        hasilKirim = await kirim((tId) => tgBot.sendVideo(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, fileOpts));
                    } else if (tipeUnduh === 'audio') {
                        if (isiPesan.audioMessage) {
                            if (isiPesan.audioMessage.ptt) {
                                hasilKirim = await kirim((tId) => tgBot.sendVoice(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, fileOpts));
                            } else {
                                hasilKirim = await kirim((tId) => tgBot.sendAudio(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, fileOpts));
                            }
                        } else {
                            hasilKirim = await kirim((tId) => tgBot.sendAudio(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, fileOpts));
                        }
                    } else {
                        hasilKirim = await kirim((tId) => tgBot.sendDocument(TG_GROUP_ID, buffer, { ...tgOpts, message_thread_id: tId }, fileOpts));
                    }
                    
                    let gOk = false;
                    if (global.gc) gOk = true;
                    if (gOk) global.gc();
                }

                await cekKataKunci(idPengirim, isFromMe, isHistory, namaPengirimFinal, teksKonten, hasilKirim);
                
                let ttKonten = teksKonten;
                if (!ttKonten) ttKonten = '[Media]';
                await notifikasiMentionDiri(isMentioned, isReplyToMe, idPengirim, hasilKirim, infoUtama, ttKonten);
            } catch (dlErr) {
                const fallbackGagal = `⚠️ [Sistem gagal mengunduh media dari WA]`;
                const tb = `${tagNotice}${awalan}${prefixArah}${quoteBlock}${fallbackGagal}\n💬 ${teksKonten}`;
                const hasilKirim = await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, tb, { message_thread_id: tId, parse_mode: 'Markdown' }));
                
                let ttKonten = teksKonten;
                if (!ttKonten) ttKonten = '[Gagal unduh media]';
                await notifikasiMentionDiri(isMentioned, isReplyToMe, idPengirim, hasilKirim, infoUtama, ttKonten);
            }
        } else {
            let bolehKirimTeks = false;
            if (teksKonten.trim() !== '') bolehKirimTeks = true;

            if (bolehKirimTeks) {
                const tb = `${tagNotice}${awalan}${prefixArah}${quoteBlock}💬 ${teksKonten}`;
                const hasilKirim = await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, tb, { message_thread_id: tId, parse_mode: 'Markdown' }));
                await cekKataKunci(idPengirim, isFromMe, isHistory, namaPengirimFinal, teksKonten, hasilKirim);
                await notifikasiMentionDiri(isMentioned, isReplyToMe, idPengirim, hasilKirim, infoUtama, teksKonten);
            }
        }
    } catch (e) {
        console.error('[TG SEND ERROR]', e.message);
    }
}

async function notifikasiMentionDiri(isMentioned, isReplyToMe, idPengirim, hasilKirim, infoUtama, teksKonten) {
    let adaSinyal = false;
    if (isMentioned) adaSinyal = true;
    if (isReplyToMe) adaSinyal = true;

    if (!adaSinyal) return;
    
    let isValidMsg = false;
    if (hasilKirim) {
        if (hasilKirim.message_id) isValidMsg = true;
    }
    if (!isValidMsg) return;

    const threadId = dbConfig.topik[idPengirim];
    if (!threadId) return;
    
    const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');
    const link = `https://t.me/c/${groupIdBersih}/${threadId}/${hasilKirim.message_id}`;
    
    let asalInfo = infoUtama.nama;
    if (infoUtama.isGrup) asalInfo = `Grup ${infoUtama.nama}`;
    
    let snippet = teksKonten;
    if (teksKonten.length > 60) {
        snippet = teksKonten.substring(0, 60) + '...';
    }

    let jenisNotif = 'DIBALAS';
    if (isMentioned) jenisNotif = 'DI-TAG / MENTION';

    let isiPesan = `🔔 *PESAN ANDA ${jenisNotif}!*`;
    isiPesan += `\n\n📍 *Lokasi:* ${asalInfo}`;
    isiPesan += `\n💬 *Pesan:* "_${snippet}_"`;
    isiPesan += `\n\n[👉 Buka Pesan di Topik](${link})`;

    await kirimKeTopik({ sysKey: 'aktivitas' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, isiPesan, { message_thread_id: tId, parse_mode: 'Markdown' }));
}

async function cekKataKunci(idPengirim, isFromMe, isHistory, namaPengirim, teksKonten, hasilKirim) {
    if (isFromMe) return;
    if (isHistory) return;
    if (!teksKonten) return;
    if (dbConfig.kataKunci.length === 0) return;
    if (dbConfig.blacklistKataKunci.includes(idPengirim)) return;

    const teksLower = teksKonten.toLowerCase();
    const cocok = dbConfig.kataKunci.find((k) => teksLower.includes(k));
    if (!cocok) return;

    let tautan = '';
    
    let msgIdOk = false;
    if (hasilKirim) {
        if (hasilKirim.message_id) msgIdOk = true;
    }

    if (msgIdOk) {
        if (dbConfig.topik[idPengirim]) {
            const groupIdBersih = TG_GROUP_ID.toString().replace('-100', '');
            tautan = `\n\n[👉 Buka Pesan di Topik](https://t.me/c/${groupIdBersih}/${dbConfig.topik[idPengirim]}/${hasilKirim.message_id})`;
        }
    }

    const mText = `🔔 *Kata Kunci Terdeteksi:* "${cocok}"\n👤 Dari: ${namaPengirim}\n💬 Isi: "${teksKonten}"${tautan}`;

    await kirimKeTopik({ sysKey: 'kataKunci' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, mText, { message_thread_id: tId, parse_mode: 'Markdown' }));
}

// =========================================================================
// MESIN WHATSAPP UTAMA
// =========================================================================
async function mulaiBotWhatsApp() {
    let keepAliveInterval = null; 
    
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
            let cegat = false;
            if (dbConfig.stealthMode) {
                if (stanza) {
                    if (stanza.tag === 'receipt') {
                        cegat = true;
                    }
                }
            }
            if (cegat) {
                const attrs = stanza.attrs;
                let finalCegat = false;
                if (attrs) {
                    if (attrs.type === 'read') finalCegat = true;
                    if (attrs.type === 'read-self') finalCegat = true;
                    if (attrs.to) {
                        if (attrs.to.includes('status@broadcast')) {
                            finalCegat = true;
                        }
                    }
                }
                if (finalCegat) return; 
            }
            return await sendNodeAsli(stanza);
        };

        globalSock = sock;

        sock.ev.on('contacts.upsert', async (contacts) => {
            let changed = false;
            for (const c of contacts) {
                let nama = c.name;
                if (!nama) nama = c.notify;
                
                let punyaIdLid = false;
                if (c.lid) {
                    if (c.id) punyaIdLid = true;
                }

                if (punyaIdLid) {
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
                let nama = c.name;
                if (!nama) nama = c.notify;
                
                let punyaIdLid = false;
                if (c.lid) {
                    if (c.id) punyaIdLid = true;
                }

                if (punyaIdLid) {
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
                if (g.subject) {
                    await renameTopikJikaPerlu(g.id, g.subject, true);
                }
                if (g.participants) {
                    for (const p of g.participants) {
                        let okLid = false;
                        if (p.lid) {
                            if (p.id) okLid = true;
                        }

                        if (okLid) {
                            if (!dbConfig.lidMap[p.lid]) {
                                dbConfig.lidMap[p.lid] = p.id;
                                changed = true;
                                if (dbConfig.topik[p.lid]) {
                                    let nTopik = dbConfig.kontak[p.lid];
                                    if (!nTopik) nTopik = p.id.split('@')[0];
                                    await renameTopikJikaPerlu(p.lid, nTopik, false);
                                }
                            }
                        }
                    }
                }
            }
            if (changed) await simpanKonfigurasiDB();
        });

        sock.ev.on('groups.update', async (updates) => {
            for (const g of updates) {
                let pS = false;
                if (g.subject) {
                    if (g.id) pS = true;
                }
                if (pS) await renameTopikJikaPerlu(g.id, g.subject, true);
            }
        });

        sock.ev.on('chats.upsert', async (chats) => {
            for (const c of chats) {
                let isGrup = false;
                if (c.id) {
                    if (c.id.endsWith('@g.us')) isGrup = true;
                }
                if (c.name) {
                    if (!isGrup) {
                        await renameTopikJikaPerlu(c.id, c.name, false);
                    }
                }
            }
        });

        sock.ev.on('chats.update', async (updates) => {
            for (const c of updates) {
                let isGrup = false;
                if (c.id) {
                    if (c.id.endsWith('@g.us')) isGrup = true;
                }
                if (c.name) {
                    if (c.id) {
                        if (!isGrup) {
                            await renameTopikJikaPerlu(c.id, c.name, false);
                        }
                    }
                }
            }
        });

        let bufferRiwayat = [];
        
        sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
            if (contacts) {
                for (const c of contacts) {
                    let nama = c.name;
                    if (!nama) nama = c.notify;

                    const pnJid = c.id;
                    const lidJid = c.lid;

                    if (nama) {
                        if (pnJid) dbConfig.kontak[pnJid] = nama;
                        if (lidJid) dbConfig.kontak[lidJid] = nama;
                    }
                    if (lidJid) {
                        if (pnJid) {
                            dbConfig.lidMap[lidJid] = pnJid;
                        }
                    }
                }
                await simpanKonfigurasiDB();
            }
            if (messages) {
                if (messages.length > 0) {
                    bufferRiwayat.push(...messages.filter((m) => {
                        let pass = false;
                        if (m.message) {
                            if (!m.key.fromMe) pass = true;
                        }
                        return pass;
                    }));
                }
            }
        });

        setTimeout(function jadwalSinkronRiwayat() {
            (async () => {
                if (bufferRiwayat.length === 0) { setTimeout(jadwalSinkronRiwayat, 60000); return; }
                sedangSinkronisasi = true; perbaruiStatusTelegram(statusHpSaatIni, true);

                try {
                    const perKontak = {};
                    for (const msg of bufferRiwayat) {
                        const jid = msg.key.remoteJid;
                        if (!perKontak[jid]) perKontak[jid] = [];
                        
                        if (perKontak[jid].length < HISTORY_BATCH_SIZE) {
                            perKontak[jid].push(msg);
                        }
                    }
                    bufferRiwayat = [];

                    for (const jid of Object.keys(perKontak)) {
                        const arr = perKontak[jid];
                        const pesanTerurut = arr.sort((a, b) => {
                            let tA = 0;
                            if (a.messageTimestamp) tA = a.messageTimestamp;
                            let tB = 0;
                            if (b.messageTimestamp) tB = b.messageTimestamp;
                            return tA - tB;
                        });

                        for (const msg of pesanTerurut) {
                            masukAntrean(msg, msg.pushName, true);
                        }
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
            const kList = Object.keys(presence.presences);
            let state = '';
            if (kList.length > 0) {
                const kPertama = kList[0];
                const obj = presence.presences[kPertama];
                if (obj) {
                    if (obj.lastKnownPresence) state = obj.lastKnownPresence;
                }
            }

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
            let sNum = 'LID';
            if (info.nomor !== 'Disembunyikan (LID)') sNum = '+' + info.nomor;

            let baris = `ℹ️ *INFO KONTAK*\nNama: ${info.nama}\nNomor: ${sNum}\nStatus: ${icon}`;
            if (icon === '🔴 Offline') {
                if (lastSeenMap[jid]) {
                    baris += `\n🕒 Terakhir terlihat: ${waktuLokal(new Date(lastSeenMap[jid]))}`;
                }
            }

            safeTG(() => tgBot.editMessageText(baris, { chat_id: TG_GROUP_ID, message_id: msgId, parse_mode: 'Markdown' }));
        });

        async function mintaKodePairing(retryCount = 0) {
            try {
                let skipKode = false;
                if (!globalSock) skipKode = true;
                if (sock.authState.creds.registered) skipKode = true;
                if (sudahMemintaKode) skipKode = true;
                if (!dbConfig.nomor_wa_utama) skipKode = true;

                if (skipKode) return;
                
                sudahMemintaKode = true;
                const nomor = dbConfig.nomor_wa_utama.replace(/[^0-9]/g, '');
                let kode = await sock.requestPairingCode(nomor);
                if (kode) {
                    const r = kode.match(/.{1,4}/g);
                    if (r) kode = r.join('-');
                }

                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔑 *KODE PAIRING:* \`${kode}\`\nNomor: ${nomor}`, { parse_mode: 'Markdown' }));
            } catch (err) {
                sudahMemintaKode = false;
                if (retryCount < 3) {
                    setTimeout(() => mintaKodePairing(retryCount + 1), 5000);
                } else {
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal pairing otomatis. Kirim /login manual.`));
                }
            }
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            let runPair = false;
            if (connection === 'connecting') {
                if (!sock.authState.creds.registered) {
                    if (!sedangMenungguPairing) {
                        if (dbConfig.nomor_wa_utama) runPair = true;
                    }
                }
            }

            if (runPair) {
                sedangMenungguPairing = true;
                setTimeout(() => mintaKodePairing(0), 2000);
            }

            if (connection === 'close') {
                if (keepAliveInterval) clearInterval(keepAliveInterval);
                globalSock = null; 
                sedangMenungguPairing = false; 
                sudahMemintaKode = false;
                
                let statusCode = '?';
                if (lastDisconnect) {
                    if (lastDisconnect.error) {
                        if (lastDisconnect.error.output) {
                            if (lastDisconnect.error.output.statusCode) {
                                statusCode = lastDisconnect.error.output.statusCode;
                            }
                        }
                    }
                }

                let isLoggedOut = false;
                if (statusCode === DisconnectReason.loggedOut) isLoggedOut = true;
                if (statusCode === 401) isLoggedOut = true;

                if (isLoggedOut) {
                    try { await authCollection.deleteMany({}); } catch (e) {}
                    perbaruiStatusTelegram(`Logout (${statusCode}) - perlu /login ulang.`, true);
                } else { 
                    perbaruiStatusTelegram(`Terputus (${statusCode}), menyambung ulang...`, true); 
                }
                setTimeout(mulaiBotWhatsApp, 5000);
            } else if (connection === 'open') {
                sedangMenungguPairing = false;
                
                if (keepAliveInterval) clearInterval(keepAliveInterval);
                keepAliveInterval = setInterval(async () => {
                    if (globalSock) {
                        if (globalSock.ws) {
                            if (globalSock.ws.isOpen) {
                                try { await globalSock.ws.ping(); } catch (e) {}
                            }
                        }
                    }
                }, 45000);

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
                let jenis = 'Suara';
                if (call.isVideo) jenis = 'Video';
                let labelGrup = '';
                if (call.isGroup) labelGrup = ' GRUP';

                let isMasuk = false;
                if (call.status === 'offer') isMasuk = true;
                if (call.status === 'ringing') isMasuk = true;

                if (isMasuk) {
                    let hasNotif = false;
                    if (callStateMap[callId]) {
                        if (callStateMap[callId].notifDering) hasNotif = true;
                    }
                    if (hasNotif) continue;
                    
                    callStateMap[callId] = { startTime: Date.now(), answered: false, notifDering: true };
                    await kirimLogPanggilan(call.from, `📞 *[PANGGILAN ${jenis}${labelGrup} MASUK]*\n👤 Dari: ${info.nama}\n🕒 ${waktuLokal()}`);
                    continue;
                }

                if (call.status === 'accept') {
                    let hasAngkat = false;
                    if (callStateMap[callId]) {
                        if (callStateMap[callId].notifDiangkat) hasAngkat = true;
                    }
                    if (hasAngkat) continue;

                    let bState = callStateMap[callId];
                    if (!bState) bState = {};
                    bState.answered = true;
                    bState.acceptTime = Date.now();
                    bState.notifDiangkat = true;
                    callStateMap[callId] = bState;

                    await kirimLogPanggilan(call.from, `📞 *[PANGGILAN DIANGKAT]*\n👤 Dengan: ${info.nama}`);
                    continue;
                }

                let isEnd = false;
                if (call.status === 'terminate') isEnd = true;
                if (call.status === 'reject') isEnd = true;
                if (call.status === 'timeout') isEnd = true;

                if (isEnd) {
                    const state = callStateMap[callId];
                    delete callStateMap[callId]; 

                    let adaJawab = false;
                    if (state) {
                        if (state.answered) {
                            if (state.acceptTime) adaJawab = true;
                        }
                    }

                    if (adaJawab) {
                        const durasiDetik = Math.max(0, Math.round((Date.now() - state.acceptTime) / 1000));
                        const menit = Math.floor(durasiDetik / 60);
                        const detik = durasiDetik % 60;
                        await kirimLogPanggilan(call.from, `📞 *[SESI PANGGILAN SELESAI]*\n👤 Dengan: ${info.nama}\n⏱️ Durasi: ~${menit}m ${detik}d`);
                    } else if (state) {
                        if (!state.answered) {
                            let statusLabel = 'TIDAK TERJAWAB';
                            if (call.status === 'reject') statusLabel = 'DITOLAK';
                            if (call.offline) statusLabel = 'DITOLAK';
                            await kirimLogPanggilan(call.from, `📞 *[PANGGILAN ${statusLabel}]*\n👤 Dari: ${info.nama}`);
                        }
                    } else {
                        let statusLabel = 'BERAKHIR / TAK TERJAWAB';
                        if (call.status === 'reject') statusLabel = 'DITOLAK';
                        await kirimLogPanggilan(call.from, `📞 *[PANGGILAN ${statusLabel}]*\n👤 Dari: ${info.nama}`);
                    }
                }
            }
        });

        sock.ev.on('group-participants.update', async (event) => {
            try {
                await pastikanTopik(event.id);
                const daftarNama = event.participants.map((p) => ambilInfoKontak(p, null).nama).join(', ');
                const dictAksi = { add: '➕ Bergabung', remove: '➖ Keluar', promote: '⬆️ Jadi admin', demote: '⬇️ Admin dicabut' };
                let aksi = dictAksi[event.action];
                if (!aksi) aksi = event.action;

                await kirimKeTopik({ jid: event.id }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👥 [GRUP] ${aksi}: ${daftarNama}`, { message_thread_id: tId }));
            } catch (e) {}
        });

        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                
                let isMyStatusUpdate = false;
                if (update.key.remoteJid === 'status@broadcast') {
                    if (update.update.status === 4) isMyStatusUpdate = true;
                }

                if (isMyStatusUpdate) {
                    const info = ambilInfoKontak(update.key.participant, null);
                    const statMem = statusMemory.get(update.key.id);
                    
                    let doSend = false;
                    if (statMem) {
                        if (!statMem.viewers.includes(update.key.participant)) doSend = true;
                    }

                    if (doSend) {
                        statMem.viewers.push(update.key.participant);
                        statusMemory.set(update.key.id, statMem);
                        
                        let totalAllowed = 0;
                        if (statMem.audience) {
                            if (statMem.audience.length) totalAllowed = statMem.audience.length;
                        }
                        
                        const totalViewed = statMem.viewers.length;
                        let ratioText = `(${totalViewed} penonton)`;
                        if (totalAllowed > 0) {
                            ratioText = `(${totalViewed} dari ${totalAllowed} yang diizinkan)`;
                        }
                        
                        let txtMem = statMem.teks;
                        if (!txtMem) txtMem = 'Media';

                        kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👀 *${info.nama}* baru saja melihat status Anda ${ratioText}:\n👉 _"${txtMem}"_`, { message_thread_id: tId, parse_mode: 'Markdown' }));
                    }
                    continue;
                }

                if (update.update.status) {
                    const tgData = msgMapCache.get(update.key.id);
                    if (tgData) {
                        const st = update.update.status;
                        if (st === 2) await setTGReaksi(tgData.tgMsgId, '👍');
                        else if (st === 3) await setTGReaksi(tgData.tgMsgId, '👌');
                        else if (st === 4) { await setTGReaksi(tgData.tgMsgId, '👀'); msgMapCache.del(update.key.id); }
                    }
                }

                if (update.update.protocolMessage) {
                    await prosesProtokolPesan(update.update.protocolMessage, update.key.participant);
                }
            }
        });

        sock.ev.on('chats.delete', (ids) => console.log('[INFO] chats.delete diabaikan sengaja'));

        sock.ev.on('messages.upsert', async (chatUpdate) => {
            const infoPesan = chatUpdate.messages[0];
            if (!infoPesan) return;
            if (!infoPesan.message) return;

            const idPesan = infoPesan.key.id;
            
            if (cacheAntiSpam.has(idPesan)) return;
            cacheAntiSpam.set(idPesan, true);

            let pushName = infoPesan.pushName;
            if (!pushName) pushName = 'Kontak';
            const jid = infoPesan.key.remoteJid;

            const protoLangsung = infoPesan.message.protocolMessage;
            let protoDalamEdit = null;
            if (infoPesan.message.editedMessage) {
                if (infoPesan.message.editedMessage.message) {
                    if (infoPesan.message.editedMessage.message.protocolMessage) {
                        protoDalamEdit = infoPesan.message.editedMessage.message.protocolMessage;
                    }
                }
            }
            
            if (protoLangsung) { 
                await prosesProtokolPesan(protoLangsung, infoPesan.key.participant); 
                return; 
            } else if (protoDalamEdit) {
                await prosesProtokolPesan(protoDalamEdit, infoPesan.key.participant); 
                return; 
            }

            if (jid === 'status@broadcast') {
                const isMyOwn = infoPesan.key.fromMe;
                
                let isBlist = false;
                if (!isMyOwn) {
                    if (dbConfig.blacklistStatus.includes(infoPesan.key.participant)) isBlist = true;
                }
                
                if (isBlist) return;
                
                antreanStatus.push(infoPesan);
                if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
                return;
            }
            
            let isiPesan = infoPesan.message;
            if (isiPesan) {
                if (isiPesan.ephemeralMessage) isiPesan = isiPesan.ephemeralMessage.message;
            }
            if (isiPesan) {
                if (isiPesan.documentWithCaptionMessage) isiPesan = isiPesan.documentWithCaptionMessage.message;
            }
            
            if (!isiPesan) return;

            const tipePesan = Object.keys(isiPesan).find((k) => {
                let ok = true;
                if (k === 'senderKeyDistributionMessage') ok = false;
                if (k === 'messageContextInfo') ok = false;
                return ok;
            });

            if (!tipePesan) return; 

            if (infoPesan.key.fromMe) {
                if (!msgMapCache.has(idPesan)) masukAntrean(infoPesan, pushName, false, true);
                return;
            }

            masukAntrean(infoPesan, pushName, false);
        });
    } catch (err) {
        console.error('[WA INIT ERROR]', err.message);
        setTimeout(mulaiBotWhatsApp, 10000);
    }
}

// =========================================================================
// EXPRESS SERVER, HEARTBEAT, GARBAGE COLLECTOR & DISK SWEEPER
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
    } catch (e) {}
}, 20000);

const app = express();
app.get('/', (req, res) => res.send('WA-Tele Bridge Aktif 🚀'));

process.on('SIGTERM', async () => {
    console.log('[SYS] Sinyal shutdown diterima.');
    if (globalSock) globalSock.end();
    await mongoClient.close();
    process.exit(0);
});

function bersihkanTempMedia() {
    const tmp = os.tmpdir();
    fs.readdirSync(tmp).forEach(file => {
        let isT = false;
        if (file.startsWith('media_')) isT = true;
        if (file.startsWith('foto_')) isT = true;
        if (file.startsWith('video_')) isT = true;
        if (file.startsWith('dokumen_')) isT = true;
        if (file.startsWith('audio_')) isT = true;
        if (file.startsWith('status.')) isT = true;

        if (isT) {
            try { 
                fs.unlinkSync(path.join(tmp, file)); 
                console.log(`[Disk Sweeper] Sisa file lama dihapus: ${file}`); 
            } catch (e) {}
        }
    });
}

const PORT = process.env.PORT ? process.env.PORT : 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server aktif di port ${PORT}.`);
    bersihkanTempMedia();
    inisialisasiDenganRetry();
});

async function inisialisasiDenganRetry(percobaan = 1) {
    try {
        await hubungkanDatabase();
        await mulaiBotWhatsApp();
    } catch (e) {
        if (percobaan < 5) {
            await new Promise((r) => setTimeout(r, 5000));
            return inisialisasiDenganRetry(percobaan + 1);
        }
        process.exit(1);
    }
}
