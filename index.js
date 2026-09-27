// =========================================================================
// INDEX.JS - BOT WA-TELEGRAM HYBRID (MASTERPIECE EDITION)
// Gabungan: Lazy History Sync + MongoDB Auth + StealthBridge System
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

// =========================================================================
// KONFIGURASI LINGKUNGAN & VARIABEL GLOBAL
// =========================================================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_GROUP_ID = process.env.TG_GROUP_ID;
const MONGODB_URI = process.env.MONGODB_URI;

const MAX_FILE_SIZE_MB = 5;
const HISTORY_SYNC_DELAY_MS = 15 * 60 * 1000; 
const HISTORY_BATCH_SIZE = 40; 

if (!TG_TOKEN || !TG_GROUP_ID || !MONGODB_URI) {
    console.error('[FATAL] Pastikan TG_TOKEN, TG_GROUP_ID, MONGODB_URI sudah diset di Render.');
    process.exit(1);
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
tgBot.on('polling_error', (err) => console.error('[TG POLLING] Gangguan koneksi diabaikan:', err.message));

const cacheAntiSpam = new NodeCache({ stdTTL: 3600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;

// Memory Cache & Config Utama
let dbConfig = {
    topik: {},
    sysTopics: {},
    muted: [],
    stealthMode: true,
    nomorWaUtama: process.env.NOMOR_WA_UTAMA || null,
    pinned_status_msg_id: null
};

let statusHpSaatIni = 'Menghubungkan...';
let waktuTerakhirAktif = Date.now();
let sedangMemprosesAntrean = false;
let sedangSinkronisasi = false;
const antreanPesan = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================================
// FUNGSI TELEGRAM (ANTI RATE-LIMIT 429)
// =========================================================================
async function safeTG(apiCall) {
    for (let i = 0; i < 3; i++) {
        try {
            return await apiCall();
        } catch (e) {
            if (e.message && e.message.includes('429')) {
                const wait = parseInt(e.message.match(/retry after (\d+)/)?.[1] || '30', 10);
                await delay((wait + 1) * 1000);
            } else if (e.message && (e.message.includes('entities') || e.message.includes('too long'))) {
                return null; // Abaikan error format teks
            } else {
                return null;
            }
        }
    }
    return null;
}

// =========================================================================
// MONGODB ADAPTER & INISIALISASI
// =========================================================================
const mongoClient = new MongoClient(MONGODB_URI);
let db, authCollection, configCollection;

async function hubungkanDatabase() {
    await mongoClient.connect();
    db = mongoClient.db('wa_backup_db');
    authCollection = db.collection('auth_sessions');
    configCollection = db.collection('bot_config');

    console.log('[DB] MongoDB berhasil terhubung.');

    const config = await configCollection.findOne({ _id: 'global_settings' });
    if (config && config.data) {
        dbConfig = { ...dbConfig, ...config.data };
    }
    
    if (!dbConfig.nomorWaUtama) {
        console.log('[INFO] Nomor Utama belum diset. Kirim /login [nomor] di Telegram.');
    }

    await inisialisasiTopikSistem();
}

async function simpanKonfigurasiDB() {
    await configCollection.updateOne(
        { _id: 'global_settings' },
        { $set: { data: dbConfig } },
        { upsert: true }
    );
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
                            if (value) {
                                tasks.push(authCollection.updateOne(
                                    { _id },
                                    { $set: { data: JSON.parse(JSON.stringify(value, BufferJSON.replacer)) } },
                                    { upsert: true }
                                ));
                            } else {
                                tasks.push(authCollection.deleteOne({ _id }));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await authCollection.updateOne(
                { _id: 'creds' },
                { $set: { data: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)) } },
                { upsert: true }
            );
        }
    };
}

// =========================================================================
// SYSTEM TOPICS (Dasbor Siluman)
// =========================================================================
async function inisialisasiTopikSistem() {
    const sysNames = {
        audit: "🗑️ Audit Log",
        aktivitas: "📝 Log Aktivitas",
        statusWA: "📱 Status WA"
    };

    let updated = false;
    for (const [key, name] of Object.entries(sysNames)) {
        if (!dbConfig.sysTopics[key]) {
            const t = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, name));
            if (t) {
                dbConfig.sysTopics[key] = t.message_thread_id;
                updated = true;
                await delay(2000); // Jeda anti rate-limit
            }
        }
    }
    if (updated) await simpanKonfigurasiDB();
}

async function pastikanTopik(jid, pushName) {
    if (dbConfig.topik[jid]) return dbConfig.topik[jid];

    const isGrup = jid.endsWith('@g.us');
    const nomor = jid.split('@')[0];
    
    // INTEGRASI PUSHNAME (Nama Asli)
    let namaFolder = isGrup ? `👥 GRUP: ${nomor}` : `👤 ${pushName || 'Kontak'} (${nomor})`;
    namaFolder = namaFolder.substring(0, 127); // Batas karakter Telegram

    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) return null; // Jika gagal, return null agar masuk ke ruang General

    dbConfig.topik[jid] = result.message_thread_id;
    await simpanKonfigurasiDB();
    return result.message_thread_id;
}

// =========================================================================
// COMMAND CENTER TELEGRAM
// =========================================================================
async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && dbConfig.pinned_status_msg_id && antreanPesan.length === 0 && !sedangSinkronisasi) return;
    statusHpSaatIni = statusBaru;

    const stealthStatus = dbConfig.stealthMode ? '🟢 AKTIF (Centang 1)' : '🔴 MATI (Normal)';
    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 Koneksi WA: *${statusBaru}*\n🛡️ Stealth Mode: ${stealthStatus}\n📦 Antrean Pesan: ${antreanPesan.length}`;
    if (sedangSinkronisasi) teksStatus += `\n⏳ Sinkronisasi riwayat lama berjalan...`;

    try {
        if (dbConfig.pinned_status_msg_id) {
            await safeTG(() => tgBot.editMessageText(teksStatus, { chat_id: TG_GROUP_ID, message_id: dbConfig.pinned_status_msg_id, parse_mode: 'Markdown' }));
        } else {
            const msg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, teksStatus, { parse_mode: 'Markdown' }));
            if (msg) {
                dbConfig.pinned_status_msg_id = msg.message_id;
                await simpanKonfigurasiDB();
                await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, dbConfig.pinned_status_msg_id, { disable_notification: true }));
            }
        }
    } catch (e) {
        dbConfig.pinned_status_msg_id = null;
    }
}

tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    const teks = msg.text || '';
    const threadId = msg.message_thread_id;
    const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);

    const args = teks.split(' ');
    const cmd = args[0].toLowerCase();

    // MENU SISTEM
    if (teks === '/help') {
        const help = `🛠️ *MENU COMMAND*\n/status - Diagnostik server\n/login [nomor] - Pairing WA\n/stealth [on/off] - Mode Centang 1\n/mute & /unmute - Bisukan Topik\n/gantiwa [nomor] - Ganti nomor WA\n/restart - Muat ulang server`;
        return tgBot.sendMessage(TG_GROUP_ID, help, { message_thread_id: threadId, parse_mode: 'Markdown' });
    }

    if (cmd === '/login') {
        if (!args[1]) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Format: \`/login 628123456789\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        const nomor = args[1].replace(/[^0-9]/g, '');

        if (!globalSock) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Socket WA belum siap, tunggu sebentar.`, { message_thread_id: threadId }));
        if (globalSock.authState.creds.registered) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Bot sudah login.`, { message_thread_id: threadId }));
        
        dbConfig.nomorWaUtama = nomor;
        await simpanKonfigurasiDB();
        
        try {
            let kode = await globalSock.requestPairingCode(nomor);
            kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔑 *KODE PAIRING:* \`${kode}\`\nNomor: ${nomor}\n\nMasukkan di WhatsApp > Perangkat Tertaut.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        } catch (e) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal: ${e.message}`, { message_thread_id: threadId }));
        }
    }

    if (cmd === '/stealth') {
        dbConfig.stealthMode = teks.includes('on');
        await simpanKonfigurasiDB();
        perbaruiStatusTelegram(statusHpSaatIni, true);
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🛡️ Stealth Mode: ${dbConfig.stealthMode ? '🟢 ON' : '🔴 OFF'}`, { message_thread_id: threadId }));
    }

    if (cmd === '/mute' && targetJid) {
        if (!dbConfig.muted.includes(targetJid)) dbConfig.muted.push(targetJid);
        await simpanKonfigurasiDB();
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔇 Topik dibisukan. Pesan baru tidak akan masuk ke sini.`, { message_thread_id: threadId }));
    }
    
    if (cmd === '/unmute' && targetJid) {
        dbConfig.muted = dbConfig.muted.filter(j => j !== targetJid);
        await simpanKonfigurasiDB();
        return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔊 Topik kembali aktif.`, { message_thread_id: threadId }));
    }

    if (cmd === '/status') {
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        return tgBot.sendMessage(TG_GROUP_ID, `📊 RAM: ${ram} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}\n📥 Antrean: ${antreanPesan.length}`, { message_thread_id: threadId });
    }

    if (cmd === '/gantiwa') {
        const nomorBaru = args[1]?.replace(/[^0-9]/g, '');
        if (!nomorBaru) return tgBot.sendMessage(TG_GROUP_ID, '⚠️ Format: /gantiwa 62812xxxxxxx', { message_thread_id: threadId });

        await tgBot.sendMessage(TG_GROUP_ID, `🔄 *MEMULAI GANTI NOMOR*\nTarget: ${nomorBaru}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
        dbConfig.nomorWaUtama = nomorBaru;
        await simpanKonfigurasiDB();
        if (globalSock) { try { await globalSock.logout(); } catch (e) {} }
        await authCollection.deleteMany({});
        await delay(2000);
        process.exit(1); 
    }

    if (cmd === '/restart') {
        await tgBot.sendMessage(TG_GROUP_ID, `🔄 Memulai ulang server...`, { message_thread_id: threadId });
        process.exit(1);
    }

    // BALAS PESAN WA DARI TOPIK
    if (targetJid && globalSock && !teks.startsWith('/')) {
        await globalSock.sendPresenceUpdate('composing', targetJid);
        await delay(2000);
        await globalSock.sendPresenceUpdate('paused', targetJid);
        globalSock.sendMessage(targetJid, { text: teks }).catch(() => {});
    }
});

// FITUR BYPASS CENTANG BIRU (Reaksi 👀)
tgBot.on('message_reaction', async (reaction) => {
    if (reaction.new_reaction.some(r => r.emoji === '👀')) {
        const threadId = reaction.message_thread_id;
        const targetJid = Object.keys(dbConfig.topik).find(k => dbConfig.topik[k] === threadId);
        if (targetJid && globalSock) {
            // Mengirim status online singkat agar pesan tercentang biru di HP pengirim
            await globalSock.sendPresenceUpdate('available', targetJid);
            await delay(1000);
            await globalSock.sendPresenceUpdate('unavailable', targetJid);
            safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Centang biru dipaksa untuk kontak ini.`, { message_thread_id: threadId }));
        }
    }
});

// =========================================================================
// SISTEM ANTREAN TELEGRAM
// =========================================================================
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
        if (global.gc && antreanPesan.length % 20 === 0) global.gc();
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function eksekusiKirimKeTelegram(infoPesan, isHistory, pushName) {
    const idPengirim = infoPesan.key.remoteJid;
    if (dbConfig.muted.includes(idPengirim)) return; // Blokir pesan masuk jika di-mute

    const tipePesan = Object.keys(infoPesan.message)[0];
    const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';

    // Cache untuk Anti-Delete
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan });

    let threadId = await pastikanTopik(idPengirim, pushName);
    const opts = threadId ? { message_thread_id: threadId } : {}; // Jika gagal bikin topik, masuk General

    const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage
        || infoPesan.message.audioMessage || infoPesan.message.documentMessage;
    const awalan = isHistory ? '🕰️ [Riwayat] ' : '💬 ';

    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            if (ukuranBytes > MAX_FILE_SIZE_MB * 1024 * 1024) {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID,
                    `⚠️ [Media Dilewati] Ukuran melebihi ${MAX_FILE_SIZE_MB}MB.`, opts));
                return;
            }
            const streamMedia = await downloadContentFromMessage(pesanMedia, tipePesan.replace('Message', ''));
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);

            await safeTG(() => tgBot.sendDocument(TG_GROUP_ID, bufferMedia, 
                { ...opts, caption: isHistory ? '🕰️ Media lama' : `📂 Media\n\n${teksKonten}` },
                { filename: `media_${infoPesan.key.id}` }
            ));
        } else if (teksKonten.trim() !== '') {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${awalan}${teksKonten}`, opts));
        }
    } catch (e) {
        console.error('[TG SEND ERROR]', e.message);
    }
}

// =========================================================================
// MESIN WHATSAPP UTAMA (Baileys)
// =========================================================================
async function mulaiBotWhatsApp() {
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
        emitOwnEvents: true,
        markOnlineOnConnect: false, // Wajib false untuk stealth mode
        syncFullHistory: false 
    });

    globalSock = sock;

    // INTEGRASI STEALTH MODE (Mencegat Centang Biru / Read Receipts)
    const orgSendNode = sock.sendNode;
    sock.sendNode = function (node) {
        if (dbConfig.stealthMode && node.tag === 'receipt' && (node.attrs?.type === 'delivery' || node.attrs?.type === 'read')) {
            return Promise.resolve(); // Hancurkan sinyal ke server Meta
        }
        return orgSendNode.apply(this, arguments);
    };

    // LAZY HISTORY SYNC
    let bufferRiwayat = [];
    sock.ev.on('messaging-history.set', async ({ messages }) => {
        if (!messages || messages.length === 0) return;
        bufferRiwayat.push(...messages.filter((m) => m.message && !m.key.fromMe));
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
                for (const msg of pesanTerurut) masukAntrean(msg, true, msg.pushName);
                await delay(3000); 
            }

            sedangSinkronisasi = false;
            perbaruiStatusTelegram(statusHpSaatIni, true);
            setTimeout(jadwalSinkronRiwayat, 60 * 60 * 1000); 
        })();
    }, HISTORY_SYNC_DELAY_MS);

    // PAIRING CODE LOGIC
    async function mintaKodePairing(retryCount = 0) {
        try {
            if (!globalSock || sock.authState.creds.registered || sudahMemintaKode || !dbConfig.nomorWaUtama) return;
            sudahMemintaKode = true;
            const cleanNumber = dbConfig.nomorWaUtama.replace(/[^0-9]/g, '');

            let kodePairing = await sock.requestPairingCode(cleanNumber);
            kodePairing = kodePairing?.match(/.{1,4}/g)?.join('-') || kodePairing;

            await tgBot.sendMessage(
                TG_GROUP_ID,
                `⚠️ *KODE PAIRING:* \`${kodePairing}\`\nNomor: ${cleanNumber}\n\nMasukkan di WhatsApp > Perangkat Tertaut dalam waktu 60 detik.`,
                { parse_mode: 'Markdown' }
            );
        } catch (err) {
            sudahMemintaKode = false; 
            if (retryCount < 3) {
                setTimeout(() => mintaKodePairing(retryCount + 1), 5000);
            } else {
                tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal mengambil kode pairing. Coba /restart.`);
            }
        }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting' && !sock.authState.creds.registered && !sedangMenungguPairing && dbConfig.nomorWaUtama) {
            sedangMenungguPairing = true;
            setTimeout(() => mintaKodePairing(0), 2000);
        }

        if (connection === 'close') {
            globalSock = null;
            sedangMenungguPairing = false;
            sudahMemintaKode = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

            if (isLoggedOut) {
                try { await authCollection.deleteMany({}); } catch (e) {}
                perbaruiStatusTelegram(`Logout (${statusCode}) - perlu pairing ulang.`, true);
            } else {
                perbaruiStatusTelegram(`Terputus (${statusCode || '?'}), menyambung ulang...`, true);
            }
            setTimeout(mulaiBotWhatsApp, 5000);
        } else if (connection === 'open') {
            sedangMenungguPairing = false;
            perbaruiStatusTelegram('Online');
            await sock.sendPresenceUpdate('unavailable'); // Stealth Mode Init
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // CALL LOGS (Log Panggilan Masuk)
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            const txt = `📞 **[PANGGILAN ${call.status === 'offer' ? 'MASUK' : 'BERAKHIR'}]**\n👤 Dari: ${call.from.split('@')[0]}\n🕒 Waktu: ${new Date().toLocaleString('id-ID')}`;
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, txt, { message_thread_id: dbConfig.sysTopics.audit }));
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const infoPesan = chatUpdate.messages[0];
        if (!infoPesan || !infoPesan.message) return;

        const pushName = infoPesan.pushName || 'Kontak';
        const jid = infoPesan.key.remoteJid;

        // STATUS WA (Story) -> Lempar ke Topik Khusus Status WA
        if (jid === 'status@broadcast') {
            const pembuat = infoPesan.key.participant?.split('@')[0] || 'Unknown';
            const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '[Media/Foto]';
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📱 **Status: ${pembuat}**\n${teksKonten}`, { message_thread_id: dbConfig.sysTopics.statusWA }));
            return;
        }

        // Pesan Keluar (Dari HP Utama) -> Lempar ke Log Aktivitas & Topik Terkait
        if (infoPesan.key.fromMe) {
            waktuTerakhirAktif = Date.now();
            try {
                const threadId = await pastikanTopik(jid, pushName);
                const teksKeluar = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '[Media]';
                if (threadId) {
                    const tgMsg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📤 (Anda via HP): ${teksKeluar}`, { message_thread_id: threadId }));
                    if (tgMsg) {
                        const link = `https://t.me/c/${TG_GROUP_ID.toString().replace('-100', '')}/${threadId}/${tgMsg.message_id}`;
                        await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📱 **[PESAN KELUAR HP]** ke *${pushName}*\n➡️ [Lihat Pesan](${link})`, { message_thread_id: dbConfig.sysTopics.aktivitas, parse_mode: 'Markdown' }));
                    }
                }
            } catch (e) {}
            return;
        }

        const idPesan = infoPesan.key.id;
        if (cacheAntiSpam.has(idPesan)) return;
        cacheAntiSpam.set(idPesan, true);

        // Masuk Antrean Telegram & Bawa PushName
        masukAntrean(infoPesan, false, pushName);
    });

    // ANTI-DELETE & ANTI-EDIT (Dikirim ke Audit Log & Topik Asli)
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            const protocol = update.update.protocolMessage;
            if (!protocol) continue;

            const idTarget = protocol.key.id;
            const dataAsli = cacheAntiDelete.get(idTarget);
            const jid = protocol.key.remoteJid;
            const threadId = dbConfig.topik[jid];
            const opts = threadId ? { message_thread_id: threadId } : {};

            if (protocol.type === 0) { // REVOKE
                const note = `⚠️ [PESAN DIHAPUS PENGIRIM]\n👉 Isi: "${dataAsli?.teks || 'Media/Tidak diketahui'}"`;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🗑️ **[AUDIT - HAPUS]** JID: ${jid}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                
            } else if (protocol.type === 14) { // EDIT
                const teksBaru = protocol.editedMessage?.conversation || protocol.editedMessage?.extendedTextMessage?.text || '(tidak terbaca)';
                const note = `✏️ [PESAN DIEDIT]\n👉 Sblm: "${dataAsli?.teks || '?'}"\n👉 Ssdh: "${teksBaru}"`;
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, note, opts));
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📝 **[AUDIT - EDIT]** JID: ${jid}\n${note}`, { message_thread_id: dbConfig.sysTopics.audit }));
                
                if (dataAsli) cacheAntiDelete.set(idTarget, { ...dataAsli, teks: teksBaru });
            }
        }
    });
}

// =========================================================================
// EXPRESS SERVER & BOOT SEQUENCE
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
    } catch (e) {}
}, 20000);

const app = express();
app.get('/', (req, res) => res.send('Bot WhatsApp ke Telegram Aktif & Stealth 🚀'));

process.on('SIGTERM', async () => {
    if (globalSock) globalSock.end();
    await mongoClient.close();
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Web server aktif di port ${PORT}. Menunggu jaringan Render stabil...`);
    
    // Jeda 5 detik anti AggregateError saat Render Booting
    setTimeout(() => {
        hubungkanDatabase()
            .then(() => {
                console.log('✅ Database MongoDB Siap!');
                mulaiBotWhatsApp();
            })
            .catch((e) => {
                console.error('[FATAL] Gagal konek database:', e.message);
                process.exit(1);
            });
    }, 5000);
});
