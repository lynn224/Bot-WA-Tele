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
const HISTORY_BATCH_SIZE = 40;

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
tgBot.on('polling_error', (err) => console.error('[TG POLLING]', err.message));

tgBot.setMyCommands([
    { command: 'help', description: 'Daftar perintah' },
    { command: 'status', description: 'Cek RAM & koneksi' },
    { command: 'setmedia', description: 'Atur batas ukuran media (MB)' },
    { command: 'info', description: 'Detail kontak topik ini' },
    { command: 'mute', description: 'Bisukan topik ini' },
    { command: 'unmute', description: 'Bunyikan topik ini' },
    { command: 'login', description: 'Tautkan/ganti nomor WA' },
    { command: 'restart', description: 'Restart server bot' }
]);

const cacheAntiSpam = new NodeCache({ stdTTL: 3600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });
// Baileys kadang mengirim event hapus/edit lewat messages.upsert, kadang lewat messages.update,
// tergantung siapa pelakunya (diri sendiri vs orang lain) dan konteks (pribadi vs grup).
// Kita dengarkan KEDUANYA supaya tidak ada yang lolos, dan cache ini mencegah notifikasi dobel
// kalau kebetulan kedua event terpicu untuk aksi yang sama.
const cacheDedupProtokol = new NodeCache({ stdTTL: 120 });
const statusMemory = new NodeCache({ stdTTL: 86400 });
const msgMapCache = new NodeCache({ stdTTL: 86400 });

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;

// Konfigurasi tunggal, dipersist ke MongoDB (skema FLAT - kompatibel dgn dashboard yang sudah dibuat)
let dbConfig = {
    topik: {},
    kontak: {},
    sysTopics: {},
    muted: [],
    nomor_wa_utama: process.env.NOMOR_WA_UTAMA || null,
    pinned_status_msg_id: null,
    maxMediaMB: 5,
    topicInfoMsgs: {}
};

let statusHpSaatIni = 'Menghubungkan...';
let sedangMemprosesAntrean = false;
let sedangSinkronisasi = false;
const antreanPesan = [];
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

// Cek apakah pesan error dari Telegram menandakan topik sudah tidak ada lagi
// (dihapus manual, atau ID basi karena grup pernah dihapus/diganti).
function isErrorTopikBasi(pesanError) {
    if (!pesanError) return false;
    return pesanError.includes('thread not found') || pesanError.includes('TOPIC_ID_INVALID') || pesanError.includes('message thread not found');
}

// Kirim ke topik kontak/grup (jid) atau topik sistem (sysKey), dengan AUTO-HEAL:
// kalau ID topik yang tersimpan ternyata sudah tidak valid lagi di sisi Telegram,
// hapus mapping lama, buat topik baru, lalu kirim ulang ke topik yang baru.
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
let authCollection, configCollection;

async function hubungkanDatabase() {
    await mongoClient.connect();
    const db = mongoClient.db('wa_backup_db');
    authCollection = db.collection('auth_sessions');
    configCollection = db.collection('bot_config');
    console.log('[DB] Terhubung ke MongoDB Atlas.');

    const config = await configCollection.findOne({ _id: 'global_settings' });
    if (config) {
        dbConfig = { ...dbConfig, ...config };
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
// INFO KONTAK (nama tersimpan HP > pushName > LID/nomor)
// =========================================================================
function ambilInfoKontak(jid, pushNameFallback) {
    if (!jid) return { nama: 'Unknown', nomor: 'Unknown', isLid: false, isGrup: false };
    const nomor = jid.split('@')[0];
    const isLid = jid.includes('@lid');
    const isGrup = jid.endsWith('@g.us');

    let nama = dbConfig.kontak[jid] || pushNameFallback;
    if (!nama) {
        nama = isGrup ? `Grup ${nomor}` : (isLid ? 'Rahasia (LID)' : `+${nomor}`);
    } else if (!dbConfig.kontak[jid]) {
        dbConfig.kontak[jid] = nama; // simpan pushName sbg fallback sementara, nanti di-upgrade oleh contacts.upsert
    }
    return { nama, nomor, isLid, isGrup };
}

// Deteksi & kirim notifikasi HAPUS/EDIT. Dipanggil dari messages.upsert MAUPUN
// messages.update (lihat komentar di deklarasi cacheDedupProtokol di atas) supaya
// tidak ada revoke/edit yang lolos tergantung dari mana event itu datang.
//
// @param protoMsg   - object protocolMessage { type, key: {id, remoteJid, ...}, editedMessage? }
// @param jidPelaku  - JID yang melakukan aksi ini menurut event (participant di grup), boleh kosong
async function prosesProtokolPesan(protoMsg, jidPelaku) {
    if (!protoMsg?.key?.id) return;
    const idTarget = protoMsg.key.id;
    const jidChat = protoMsg.key.remoteJid;
    const isHapus = protoMsg.type === 0 || protoMsg.type === 'REVOKE';
    const isEdit = protoMsg.type === 14 || protoMsg.type === 'MESSAGE_EDIT';
    if (!isHapus && !isEdit) return;

    const dedupKey = `${isHapus ? 'hapus' : 'edit'}-${idTarget}`;
    if (cacheDedupProtokol.has(dedupKey)) return; // event yang sama sudah diproses dari sumber lain
    cacheDedupProtokol.set(dedupKey, true);

    if (!dbConfig.topik[jidChat]) return; // belum pernah ada topik utk chat ini, tidak ada yg perlu dinotifikasi

    const dataAsli = cacheAntiDelete.get(idTarget);
    const namaPengirim = dataAsli?.pengirim
        || (jidPelaku ? ambilInfoKontak(jidPelaku, null).nama : ambilInfoKontak(jidChat, null).nama);

    let note;
    if (isHapus) {
        note = `🗑️ *Pesan Dihapus*\n👤 Dari: ${namaPengirim}\n💬 Isi pesan: "${dataAsli?.teks || '(media, isi tidak tercatat)'}"`;
    } else {
        const teksBaru = protoMsg.editedMessage?.conversation || protoMsg.editedMessage?.extendedTextMessage?.text || '(media/tidak terbaca)';
        note = `✏️ *Pesan Diedit*\n👤 Dari: ${namaPengirim}\n📝 Sebelum: "${dataAsli?.teks || '(tidak tercatat)'}"\n📝 Sesudah: "${teksBaru}"`;
        if (dataAsli) cacheAntiDelete.set(idTarget, { ...dataAsli, teks: teksBaru });
    }

    await kirimKeTopik({ jid: jidChat }, (tId) => tgBot.sendMessage(TG_GROUP_ID, note, { message_thread_id: tId, parse_mode: 'Markdown' }));
    await kirimKeTopik({ sysKey: 'audit' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, note, { message_thread_id: tId, parse_mode: 'Markdown' }));
}

// =========================================================================
// TOPIK TELEGRAM
// =========================================================================
async function inisialisasiTopikSistem() {
    const sysNames = { audit: '🗑️ Audit Log', aktivitas: '📝 Log Aktivitas', statusWA: '📱 Status WA' };
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

    // Untuk grup: kalau nama belum diketahui, coba tanya langsung ke WA (groupMetadata) —
    // ini query real-time yang sah (bukan pasif menunggu event), beda dari kontak perorangan
    // yang memang tidak ada API resminya untuk "intip nama tersimpan di HP orang lain".
    if (isGrup && !dbConfig.kontak[jid] && globalSock) {
        try {
            const meta = await globalSock.groupMetadata(jid);
            if (meta?.subject) dbConfig.kontak[jid] = meta.subject;
        } catch (e) {
            console.log(`[GROUP METADATA] Gagal ambil nama grup ${jid}:`, e.message);
        }
    }

    const info = ambilInfoKontak(jid, pushName);
    let namaFolder = info.isGrup ? `👥 GRUP: ${info.nama}` : `👤 ${info.nama} (${info.nomor})`;
    namaFolder = namaFolder.substring(0, 127);

    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) throw new Error('Gagal membuat topik setelah retry');

    dbConfig.topik[jid] = result.message_thread_id;

    // Pesan info topik yang di-pin, berisi nama/nomor + status online/typing (dari presence.update,
    // yaitu info yang memang sudah dikirim WA ke akun ini secara protokol normal - bukan hasil manipulasi).
    if (!info.isGrup) {
        const displayNum = info.isLid ? 'Rahasia (LID)' : `+${info.nomor}`;
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
    const namaLama = dbConfig.kontak[jid];
    dbConfig.kontak[jid] = namaBaru;
    if (namaLama === namaBaru) return;
    await simpanKonfigurasiDB();

    const threadId = dbConfig.topik[jid];
    if (!threadId) return;

    const namaTopikBaru = isGrup ? `👥 GRUP: ${namaBaru}` : `👤 ${namaBaru} (${jid.split('@')[0]})`;
    await safeTG(() => tgBot.editForumTopic(TG_GROUP_ID, threadId, { name: namaTopikBaru.substring(0, 127) }));
}

// =========================================================================
// STATUS COMMAND CENTER (TANPA toggle stealth)
// =========================================================================
async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && dbConfig.pinned_status_msg_id && antreanPesan.length === 0 && !sedangSinkronisasi) return;
    statusHpSaatIni = statusBaru;

    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 Koneksi WA: *${statusBaru}*\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n📦 Antrean: ${antreanPesan.length}`;
    if (sedangSinkronisasi) teksStatus += `\n⏳ Sinkronisasi riwayat berjalan...`;

    try {
        if (dbConfig.pinned_status_msg_id) {
            await safeTG(() => tgBot.editMessageText(teksStatus, { chat_id: TG_GROUP_ID, message_id: dbConfig.pinned_status_msg_id, parse_mode: 'Markdown' }));
        } else {
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
tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    const threadId = msg.message_thread_id;
    const targetJid = Object.keys(dbConfig.topik).find((k) => dbConfig.topik[k] === threadId);
    const teks = msg.text || msg.caption || '';
    const args = teks.split(' ');
    const cmd = args[0].split('@')[0].toLowerCase();

    if (cmd === '/help') {
        const help = `🛠️ *MENU COMMAND*\n/status - Diagnostik server\n/setmedia [MB] - Atur batas ukuran media\n/info - Detail kontak topik ini\n/mute /unmute - Bisukan/aktifkan topik ini\n/login [nomor] - Tautkan/ganti nomor WA\n/restart - Restart bot`;
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, help, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }

    if (cmd === '/setmedia') {
        const mb = parseInt(args[1]);
        if (isNaN(mb) || mb <= 0) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Ketik: \`/setmedia 10\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        dbConfig.maxMediaMB = mb;
        await simpanKonfigurasiDB();
        perbaruiStatusTelegram(statusHpSaatIni, true);
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Batas media: *${mb} MB*`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }

    if (cmd === '/info') {
        if (!targetJid) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Jalankan di dalam topik kontak.`, { message_thread_id: threadId }));
        const info = ambilInfoKontak(targetJid, null);
        const ketLid = info.isLid ? '\n_(Komunitas/Saluran WA — nomor asli disembunyikan WhatsApp)_' : '';
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID,
            `ℹ️ *DETAIL KONTAK*\n\n👤 Nama: ${info.nama}\n📞 Nomor: \`${info.isLid ? 'LID' : '+' + info.nomor}\`\n💬 Tipe: ${info.isGrup ? 'Grup' : 'Pribadi'}\n🆔 JID: \`${targetJid}\`${ketLid}`,
            { message_thread_id: threadId, parse_mode: 'Markdown' }));
    }

    if (cmd === '/status') {
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📊 RAM: ${ram} MB\n📁 Batas Media: ${dbConfig.maxMediaMB} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}\n📦 Antrean: ${antreanPesan.length}`, { message_thread_id: threadId }));
    }

    if (cmd === '/mute' && targetJid) {
        if (!dbConfig.muted.includes(targetJid)) dbConfig.muted.push(targetJid);
        await simpanKonfigurasiDB();
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔇 Topik dibisukan.`, { message_thread_id: threadId }));
    }
    if (cmd === '/unmute' && targetJid) {
        dbConfig.muted = dbConfig.muted.filter((j) => j !== targetJid);
        await simpanKonfigurasiDB();
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔊 Topik aktif.`, { message_thread_id: threadId }));
    }

    if (cmd === '/login') {
        const nomor = args[1]?.replace(/[^0-9]/g, '');
        if (!nomor) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Format: \`/login 628123456789\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        if (!globalSock) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Socket belum siap, tunggu sebentar.`, { message_thread_id: threadId }));
        if (globalSock.authState.creds.registered) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Sudah login. Pakai /login lagi setelah logout kalau mau ganti nomor.`, { message_thread_id: threadId }));

        dbConfig.nomor_wa_utama = nomor;
        await simpanKonfigurasiDB();
        try {
            let kode = await globalSock.requestPairingCode(nomor);
            kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔑 *KODE PAIRING:* \`${kode}\`\nMasukkan di WhatsApp > Perangkat Tertaut dlm 60 detik.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        } catch (e) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal: ${e.message}`, { message_thread_id: threadId }));
        }
    }

    if (cmd === '/restart') {
        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔄 Merestart bot...`, { message_thread_id: threadId }));
        // Tutup koneksi dengan rapi dulu sebelum keluar. Sebelumnya exit(1) langsung tanpa
        // menutup socket WA/Mongo bisa meninggalkan koneksi menggantung, yang membuat
        // startup BERIKUTNYA gagal connect (persis gejala "restart malah bikin crash").
        try { if (globalSock) globalSock.end(undefined); } catch (e) {}
        try { await mongoClient.close(); } catch (e) {}
        await delay(1000); // beri waktu log & koneksi benar-benar tertutup
        process.exit(0);
    }

    // ---- BALAS KE WA (teks & media) DARI TELEGRAM ----
    if (targetJid && globalSock && !teks.startsWith('/')) {
        // Indikator "sedang mengetik" ini JUJUR: memang sesaat sebelum bot benar-benar
        // mengirim pesan, bukan sinyal palsu yang tidak merefleksikan aksi nyata.
        await globalSock.sendPresenceUpdate('composing', targetJid);
        await delay(1200);
        await globalSock.sendPresenceUpdate('paused', targetJid);

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
            msgMapCache.set(sent.key.id, { tgMsgId: msg.message_id, threadId });
        } catch (e) {
            console.error('[KIRIM WA ERROR]', e.message);
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal kirim: ${e.message}`, { message_thread_id: threadId }));
        }
    }
});

// =========================================================================
// ANTREAN PENGIRIMAN KE TELEGRAM
// =========================================================================
async function masukAntrean(infoPesan, pushName = 'Kontak', isHistory = false) {
    antreanPesan.push({ infoPesan, pushName, isHistory });
    if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
}

async function jalankanPekerjaAntrean() {
    sedangMemprosesAntrean = true;
    while (antreanPesan.length > 0) {
        const { infoPesan, pushName, isHistory } = antreanPesan[0];
        await eksekusiKirimKeTelegram(infoPesan, pushName, isHistory);
        antreanPesan.shift();
        if (antreanPesan.length % 10 === 0) perbaruiStatusTelegram(statusHpSaatIni);
        await delay(isHistory ? 1500 : 500);
        if (global.gc && antreanPesan.length % 20 === 0) global.gc();
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function eksekusiKirimKeTelegram(infoPesan, pushName, isHistory) {
    const idPengirim = infoPesan.key.remoteJid;
    if (dbConfig.muted.includes(idPengirim)) return;

    try {
        await pastikanTopik(idPengirim, pushName);
    } catch (e) {
        return;
    }
    const kirim = (fn) => kirimKeTopik({ jid: idPengirim }, fn);
    const awalan = isHistory ? '🕰️ [Riwayat] ' : '';

    // Bongkar wrapper WhatsApp: chat dengan "pesan sementara" (disappearing messages) aktif
    // membungkus SEMUA pesan — termasuk pesan sekali-lihat — di dalam ephemeralMessage.
    // Tanpa ini, tipePesan salah terbaca sebagai 'ephemeralMessage' dan semua deteksi di
    // bawah (teks, media, view-once) gagal total untuk chat yang mengaktifkan fitur ini.
    let isiPesan = infoPesan.message;
    if (isiPesan.ephemeralMessage) isiPesan = isiPesan.ephemeralMessage.message;
    if (isiPesan.documentWithCaptionMessage) isiPesan = isiPesan.documentWithCaptionMessage.message;
    const tipePesan = Object.keys(isiPesan).find((k) => k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo');
    if (!tipePesan) return;

    // Nama pengirim ASLI pesan ini — untuk grup: peserta yang mengirim (bukan nama grupnya);
    // untuk chat pribadi: ya kontak itu sendiri. Dipakai di semua notifikasi termasuk
    // hapus/edit/view-once supaya selalu jelas "siapa yang kirim", bukan cuma "topik mana".
    const infoUtama = ambilInfoKontak(idPengirim, pushName);
    const infoPengirimAsli = (infoUtama.isGrup && infoPesan.key.participant)
        ? ambilInfoKontak(infoPesan.key.participant, infoPesan.pushName)
        : infoUtama;
    const namaPengirimGrup = infoUtama.isGrup ? `👤 *[${infoPengirimAsli.nama}]*:\n` : '';

    // ---- REAKSI EMOJI (netral, hanya melaporkan; TIDAK memaksa sinyal apa pun) ----
    if (isiPesan.reactionMessage) {
        const emoji = isiPesan.reactionMessage.text || '(dihapus)';
        const targetId = isiPesan.reactionMessage.key.id;
        const dataAsli = cacheAntiDelete.get(targetId);
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}[Reaksi ${emoji}] pada: "_${dataAsli?.teks || 'pesan/media'}_"`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    // ---- VIEW-ONCE: catat kehadirannya SAJA, jangan bongkar/simpan isinya ----
    const viewOnceKeys = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    if (viewOnceKeys.includes(tipePesan)) {
        const teksVO = `${awalan}👁️ *Pesan Sekali-Lihat*\n👤 Dari: ${infoPengirimAsli.nama}\nℹ️ Sesuai desain privasi WhatsApp, isi pesan ini tidak diteruskan atau disimpan oleh bot.`;
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, teksVO, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    // ---- LOKASI ----
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

    // ---- KONTAK ----
    if (isiPesan.contactMessage) {
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}👤 Membagikan kontak: *${isiPesan.contactMessage.displayName}*`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }
    if (isiPesan.contactsArrayMessage) {
        const jumlah = isiPesan.contactsArrayMessage.contacts?.length || 0;
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}👥 Membagikan ${jumlah} kontak`, { message_thread_id: tId }));
        return;
    }

    // ---- POLLING ----
    if (isiPesan.pollCreationMessage || isiPesan.pollCreationMessageV3) {
        const poll = isiPesan.pollCreationMessage || isiPesan.pollCreationMessageV3;
        const daftarOpsi = (poll.options || []).map((o) => `• ${o.optionName}`).join('\n');
        await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}📊 *Polling:* ${poll.name}\n${daftarOpsi}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        return;
    }

    // ---- STIKER ----
    if (isiPesan.stickerMessage) {
        try {
            const stream = await downloadContentFromMessage(isiPesan.stickerMessage, 'sticker');
            let buffer = Buffer.alloc(0);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await kirim((tId) => tgBot.sendSticker(TG_GROUP_ID, buffer, { message_thread_id: tId }));
        } catch (e) { console.error('[STIKER ERROR]', e.message); }
        return;
    }

    const teksKonten = isiPesan.conversation || isiPesan.extendedTextMessage?.text || isiPesan[tipePesan]?.caption || '';
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan, pengirim: infoPengirimAsli.nama, isGrup: infoUtama.isGrup });

    // ---- QUOTE / REPLY ----
    const contextInfo = isiPesan.extendedTextMessage?.contextInfo || isiPesan.imageMessage?.contextInfo || isiPesan.videoMessage?.contextInfo || isiPesan.documentMessage?.contextInfo;
    let quoteBlock = '';
    const botJid = globalSock?.user?.id?.split(':')[0] + '@s.whatsapp.net';

    if (contextInfo?.stanzaId && contextInfo.participant === botJid && contextInfo.remoteJid === 'status@broadcast') {
        const statMem = statusMemory.get(contextInfo.stanzaId);
        quoteBlock = `> 📝 *Membalas Status Anda:* _${contextInfo.quotedMessage?.conversation || statMem?.teks || '[Media Status]'}_\n\n`;
    } else if (contextInfo?.quotedMessage) {
        const qTeks = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || '[Media]';
        quoteBlock = `> 📝 *Membalas:* _${qTeks}_\n\n`;
    }
    const tagNotice = (contextInfo?.mentionedJid || []).includes(botJid) ? `🔔 *[ANDA DI-MENTION]*\n\n` : '';

    // ---- MEDIA UMUM ----
    const pesanMedia = isiPesan.imageMessage || isiPesan.videoMessage || isiPesan.documentMessage || isiPesan.audioMessage || isiPesan.ptvMessage;
    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            if (ukuranBytes > dbConfig.maxMediaMB * 1024 * 1024) {
                await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${awalan}⚠️ [Media Dilewati] Ukuran melebihi ${dbConfig.maxMediaMB} MB.`, { message_thread_id: tId }));
                return;
            }
            let tipeUnduh = '';
            if (isiPesan.imageMessage) tipeUnduh = 'image';
            else if (isiPesan.videoMessage || isiPesan.ptvMessage) tipeUnduh = 'video';
            else if (isiPesan.documentMessage) tipeUnduh = 'document';
            else if (isiPesan.audioMessage) tipeUnduh = 'audio';

            const stream = await downloadContentFromMessage(pesanMedia, tipeUnduh);
            let buffer = Buffer.alloc(0);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            await kirim((tId) => tgBot.sendDocument(TG_GROUP_ID, buffer,
                { message_thread_id: tId, caption: `${tagNotice}${awalan}${namaPengirimGrup}${quoteBlock}${teksKonten}`, parse_mode: 'Markdown' },
                { filename: `media_${infoPesan.key.id}` }));
        } else if (teksKonten.trim() !== '') {
            await kirim((tId) => tgBot.sendMessage(TG_GROUP_ID, `${tagNotice}${awalan}${namaPengirimGrup}${quoteBlock}💬 ${teksKonten}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
        }
    } catch (e) {
        console.error('[TG SEND ERROR]', e.message);
    }
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
            syncFullHistory: false
            // Sengaja TIDAK ada: markOnlineOnConnect:false + sendPresenceUpdate('unavailable') paksa,
            // dan TIDAK ada patch sock.sendNode. Presence & status baca berjalan natural/default.
        });
        globalSock = sock;

        // ---- SINKRONISASI NAMA KONTAK & GRUP ASLI ----
        sock.ev.on('contacts.upsert', async (contacts) => {
            for (const c of contacts) {
                const nama = c.name || c.notify;
                if (nama) await renameTopikJikaPerlu(c.id, nama, false);
            }
        });
        sock.ev.on('contacts.update', async (updates) => {
            for (const c of updates) {
                const nama = c.name || c.notify;
                if (nama) await renameTopikJikaPerlu(c.id, nama, false);
            }
        });
        sock.ev.on('groups.upsert', async (groups) => {
            for (const g of groups) if (g.subject) await renameTopikJikaPerlu(g.id, g.subject, true);
        });
        sock.ev.on('groups.update', async (updates) => {
            for (const g of updates) if (g.subject && g.id) await renameTopikJikaPerlu(g.id, g.subject, true);
        });

        // ---- LAZY HISTORY SYNC (termasuk ekstraksi nama kontak dari riwayat) ----
        let bufferRiwayat = [];
        sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
            if (contacts) {
                for (const c of contacts) {
                    const nama = c.name || c.notify;
                    if (nama && c.id) dbConfig.kontak[c.id] = dbConfig.kontak[c.id] || nama;
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

                sedangSinkronisasi = false;
                perbaruiStatusTelegram(statusHpSaatIni, true);
                setTimeout(jadwalSinkronRiwayat, 60 * 60 * 1000);
            })();
        }, HISTORY_SYNC_DELAY_MS);

        // ---- STATUS ONLINE/TYPING KONTAK: mencerminkan info yg memang dikirim WA
        // ke akun ini secara protokol normal, ditampilkan di pesan info topik yang di-pin.
        sock.ev.on('presence.update', async (presence) => {
            const jid = presence.id;
            const state = presence.presences[Object.keys(presence.presences)[0]]?.lastKnownPresence;
            const msgId = dbConfig.topicInfoMsgs[jid];
            if (!msgId) return;

            const info = ambilInfoKontak(jid, null);
            let icon = '🔴 Offline';
            if (state === 'available') icon = '🟢 Online';
            else if (state === 'composing') icon = '✍️ Mengetik...';
            else if (state === 'recording') icon = '🎤 Merekam suara...';

            safeTG(() => tgBot.editMessageText(`ℹ️ *INFO KONTAK*\nNama: ${info.nama}\nNomor: +${info.nomor}\nStatus: ${icon}`,
                { chat_id: TG_GROUP_ID, message_id: msgId, parse_mode: 'Markdown' }));
        });

        // ---- PAIRING ----
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
            console.log('[CONN UPDATE]', JSON.stringify({ connection, statusCode: lastDisconnect?.error?.output?.statusCode }));

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
                perbaruiStatusTelegram('Online');
                if (!sock.authState.creds.registered) {
                    safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Terhubung tapi belum login. Kirim \`/login 628xxx\`.`, { parse_mode: 'Markdown' }));
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // ---- PANGGILAN MASUK ----
        sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                const info = ambilInfoKontak(call.from, null);
                const st = call.status === 'offer' ? 'Berdering (Masuk)' : call.status === 'reject' ? 'Ditolak' : call.status === 'timeout' ? 'Tidak Terjawab' : call.status;
                await kirimKeTopik({ sysKey: 'audit' }, (tId) => tgBot.sendMessage(TG_GROUP_ID,
                    `📞 [PANGGILAN ${call.isVideo ? 'VIDEO' : 'SUARA'}]\n👤 Dari: ${info.nama}\n📋 Status: ${st}\n🕒 ${new Date().toLocaleString('id-ID')}`,
                    { message_thread_id: tId }));
            }
        });

        // ---- ANGGOTA GRUP ----
        sock.ev.on('group-participants.update', async (event) => {
            try {
                await pastikanTopik(event.id);
                const daftarNama = event.participants.map((p) => ambilInfoKontak(p, null).nama).join(', ');
                const aksi = { add: '➕ Bergabung', remove: '➖ Keluar/dikeluarkan', promote: '⬆️ Dijadikan admin', demote: '⬇️ Admin dicabut' }[event.action] || event.action;
                await kirimKeTopik({ jid: event.id }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👥 [GRUP] ${aksi}: ${daftarNama}`, { message_thread_id: tId }));
            } catch (e) { console.error('[GROUP EVENT ERROR]', e.message); }
        });

        // ---- STATUS/CENTANG PESAN YANG DIKIRIM BOT + VIEWER STATUS SENDIRI ----
        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                // Siapa yang melihat status WA milik akun ini (fitur bawaan WA - viewer list status sendiri)
                if (update.key.remoteJid === 'status@broadcast' && update.update.status === 4) {
                    const info = ambilInfoKontak(update.key.participant, null);
                    const statMem = statusMemory.get(update.key.id);
                    kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👀 *${info.nama}* melihat status Anda:\n👉 _"${statMem?.teks || 'Media'}"_`,
                        { message_thread_id: tId, parse_mode: 'Markdown' }));
                    continue;
                }

                // Centang kirim/baca untuk pesan yang DIKIRIM BOT dari Telegram (bukan manipulasi -
                // ini status asli pesan yg memang dikirim, ditampilkan via reaksi di pesan Telegram)
                if (update.update.status) {
                    const tgData = msgMapCache.get(update.key.id);
                    if (tgData) {
                        try {
                            if (update.update.status === 3) {
                                await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMessageReaction`, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ chat_id: TG_GROUP_ID, message_id: tgData.tgMsgId, reaction: [{ type: 'emoji', emoji: '✅' }] })
                                });
                            } else if (update.update.status === 4) {
                                await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMessageReaction`, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ chat_id: TG_GROUP_ID, message_id: tgData.tgMsgId, reaction: [{ type: 'emoji', emoji: '👀' }] })
                                });
                                msgMapCache.del(update.key.id);
                            }
                        } catch (e) {}
                    }
                }

                // Anti-delete / anti-edit (jalur #1: lewat messages.update)
                if (update.update.protocolMessage) {
                    await prosesProtokolPesan(update.update.protocolMessage, update.key.participant);
                }
            }
        });

        sock.ev.on('chats.delete', (ids) => {
            console.log('[INFO] chats.delete diabaikan sengaja agar cadangan Telegram tetap utuh:', ids);
        });

        // ---- PESAN MASUK/KELUAR ----
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            const infoPesan = chatUpdate.messages[0];
            if (!infoPesan || !infoPesan.message) return;

            const pushName = infoPesan.pushName || 'Kontak';
            const jid = infoPesan.key.remoteJid;

            // Anti-delete / anti-edit (jalur #2: kadang datang sebagai pesan baru via messages.upsert,
            // bukan messages.update — tergantung pelakunya diri sendiri atau orang lain, dan versi WA).
            // Cek langsung DAN cek di dalam editedMessage (dua bentuk yang sama-sama dipakai Baileys).
            const protoLangsung = infoPesan.message.protocolMessage;
            const protoDalamEdit = infoPesan.message.editedMessage?.message?.protocolMessage;
            if (protoLangsung || protoDalamEdit) {
                await prosesProtokolPesan(protoLangsung || protoDalamEdit, infoPesan.key.participant);
                return;
            }

            // Status WA (story) - punya orang lain ATAU status sendiri yg baru diunggah
            if (jid === 'status@broadcast') {
                let statusMsg = infoPesan.message;
                if (statusMsg.ephemeralMessage) statusMsg = statusMsg.ephemeralMessage.message;

                const isMyOwn = infoPesan.key.fromMe;
                const infoPembuat = isMyOwn ? { nama: 'ANDA SENDIRI' } : ambilInfoKontak(infoPesan.key.participant, infoPesan.pushName);
                const teksKonten = statusMsg.conversation || statusMsg.extendedTextMessage?.text || '';
                const pesanMedia = statusMsg.imageMessage || statusMsg.videoMessage;
                statusMemory.set(infoPesan.key.id, { teks: teksKonten, media: !!pesanMedia });

                const contextInfo = statusMsg.extendedTextMessage?.contextInfo || statusMsg.imageMessage?.contextInfo || statusMsg.videoMessage?.contextInfo || infoPesan.contextInfo;
                const statusJidList = contextInfo?.statusJidList || contextInfo?.bcastJidList || [];
                const privasiInfo = isMyOwn
                    ? (statusJidList.length > 0 ? `\n🔒 _Diizinkan dilihat oleh ${statusJidList.length} kontak (daftar menyusul)_` : `\n🔒 _Daftar penerima tidak terbaca dari data pesan ini_`)
                    : '';
                const caption = `📱 *Status: ${infoPembuat.nama}*\n${teksKonten}${privasiInfo}`;

                try {
                    if (pesanMedia) {
                        const tipeUnduh = statusMsg.imageMessage ? 'image' : 'video';
                        const stream = await downloadContentFromMessage(pesanMedia, tipeUnduh);
                        let buffer = Buffer.alloc(0);
                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                        await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendDocument(TG_GROUP_ID, buffer, { message_thread_id: tId, caption, parse_mode: 'Markdown' }));
                    } else {
                        await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, caption, { message_thread_id: tId, parse_mode: 'Markdown' }));
                    }
                } catch (e) { console.error('[STATUS ERROR]', e.message); }

                if (isMyOwn && statusJidList.length > 0) {
                    await delay(800);
                    const daftarPenerima = statusJidList.map((j) => `- ${ambilInfoKontak(j, null).nama}`);
                    for (let i = 0; i < daftarPenerima.length; i += 100) {
                        await kirimKeTopik({ sysKey: 'statusWA' }, (tId) => tgBot.sendMessage(TG_GROUP_ID, `👥 *Diizinkan Melihat Status Ini:*\n\n${daftarPenerima.slice(i, i + 100).join('\n')}`, { message_thread_id: tId, parse_mode: 'Markdown' }));
                        await delay(500);
                    }
                }
                return;
            }

            if (infoPesan.key.fromMe) {
                // Backup dua arah: pesan yg kamu kirim sendiri dari HP juga ikut tersalin,
                // KECUALI yang memang baru saja dikirim BOT ini sendiri (hindari duplikat).
                if (!msgMapCache.has(infoPesan.key.id)) {
                    masukAntrean(infoPesan, pushName, false);
                }
                return;
            }

            const idPesan = infoPesan.key.id;
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
                queueLength: antreanPesan.length,
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
        await new Promise((r) => setTimeout(r, 1500)); // beri waktu log ter-flush sebelum exit
        process.exit(1);
    }
}
