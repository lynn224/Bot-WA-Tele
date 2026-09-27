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
let nomorWaUtama = process.env.NOMOR_WA_UTAMA; // format: 62812xxxxxxx (tanpa +, tanpa spasi)

const MAX_FILE_SIZE_MB = 5;
const HISTORY_SYNC_DELAY_MS = 15 * 60 * 1000; // mulai lazy-sync 15 menit setelah stabil
const HISTORY_BATCH_SIZE = 40; // maks pesan lama per kontak per tarikan

if (!TG_TOKEN || !TG_GROUP_ID || !MONGODB_URI) {
    console.error('[FATAL] Pastikan TG_TOKEN, TG_GROUP_ID, MONGODB_URI sudah diset di Environment Variables Render.');
    process.exit(1);
}
if (!nomorWaUtama) {
    console.log('[INFO] NOMOR_WA_UTAMA belum diset. Kirim /login [nomor] di grup Telegram untuk memulai pairing.');
}

const tgBot = new TelegramBot(TG_TOKEN, { polling: true });
const cacheAntiSpam = new NodeCache({ stdTTL: 3600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;
let topikDatabase = {};
let idPesanStatus = null;

let statusHpSaatIni = 'Menghubungkan...';
let waktuTerakhirAktif = 0;
let sedangMemprosesAntrean = false;
let sedangSinkronisasi = false;
const antreanPesan = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wrapper retry untuk semua panggilan Telegram API: kalau kena rate-limit (429),
// tunggu sesuai waktu yang diminta Telegram lalu coba lagi, alih-alih pesan hilang.
async function safeTG(apiCall) {
    for (let i = 0; i < 3; i++) {
        try {
            return await apiCall();
        } catch (e) {
            if (e.message && e.message.includes('429')) {
                const wait = parseInt(e.message.match(/retry after (\d+)/)?.[1] || '30', 10);
                console.log(`[TG RATE LIMIT] Menunggu ${wait + 1} detik sebelum retry...`);
                await delay((wait + 1) * 1000);
            } else {
                console.error('[TG ERROR]', e.message);
                return null;
            }
        }
    }
    return null;
}

// =========================================================================
// MONGODB ADAPTER (auth state persisten -> tahan restart/sleep Render)
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
    if (config) {
        topikDatabase = config.topik || {};
        idPesanStatus = config.pinned_status_msg_id || null;
        if (config.nomor_wa_utama) nomorWaUtama = config.nomor_wa_utama;
    }
}

async function simpanKonfigurasiDB() {
    await configCollection.updateOne(
        { _id: 'global_settings' },
        { $set: {
            topik: topikDatabase,
            pinned_status_msg_id: idPesanStatus,
            nomor_wa_utama: nomorWaUtama
        } },
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
// COMMAND CENTER TELEGRAM
// =========================================================================
async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && idPesanStatus && antreanPesan.length === 0 && !sedangSinkronisasi) return;
    statusHpSaatIni = statusBaru;

    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 Status Koneksi: *${statusBaru}*\n📦 Antrean Pesan: ${antreanPesan.length}`;
    if (sedangSinkronisasi) teksStatus += `\n⏳ Sinkronisasi riwayat lama berjalan...`;

    try {
        if (idPesanStatus) {
            await safeTG(() => tgBot.editMessageText(teksStatus, { chat_id: TG_GROUP_ID, message_id: idPesanStatus, parse_mode: 'Markdown' }));
        } else {
            const msg = await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, teksStatus, { parse_mode: 'Markdown' }));
            if (msg) {
                idPesanStatus = msg.message_id;
                await simpanKonfigurasiDB();
                await safeTG(() => tgBot.pinChatMessage(TG_GROUP_ID, idPesanStatus, { disable_notification: true }));
            }
        }
    } catch (e) {
        idPesanStatus = null;
    }
}

tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    const teks = msg.text || '';
    const threadId = msg.message_thread_id;

    if (teks === '/help') {
        const help = `🛠️ *MENU COMMAND*\n/status - Diagnostik server\n/login [nomor] - Pairing/tautkan nomor WA baru\n/kirim [nomor] [pesan] - Kirim WA baru\n/gantiwa [nomor] - Ganti nomor utama & pairing ulang\n/restart - Muat ulang mesin`;
        return tgBot.sendMessage(TG_GROUP_ID, help, { message_thread_id: threadId, parse_mode: 'Markdown' });
    }

    if (teks.startsWith('/login')) {
        const parts = teks.split(' ');
        if (!parts[1]) return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Format: \`/login 628123456789\``, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        const nomor = parts[1].replace(/[^0-9]/g, '');

        if (!globalSock) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `⚠️ Socket WA belum siap, tunggu beberapa detik lalu coba lagi.`, { message_thread_id: threadId }));
        }
        if (globalSock.authState.creds.registered) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `✅ Bot sudah login. Pakai /gantiwa kalau mau ganti nomor.`, { message_thread_id: threadId }));
        }
        nomorWaUtama = nomor;
        await simpanKonfigurasiDB();
        try {
            let kode = await globalSock.requestPairingCode(nomor);
            kode = kode?.match(/.{1,4}/g)?.join('-') || kode;
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `🔑 *KODE PAIRING:* \`${kode}\`\nNomor: ${nomor}\n\nMasukkan di WhatsApp > Perangkat Tertaut dalam 60 detik.`, { message_thread_id: threadId, parse_mode: 'Markdown' }));
        } catch (e) {
            return safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal meminta kode: ${e.message}`, { message_thread_id: threadId }));
        }
    }

    if (teks === '/status') {
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        return tgBot.sendMessage(TG_GROUP_ID, `📊 RAM: ${ram} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}\n📥 Antrean: ${antreanPesan.length}`, { message_thread_id: threadId });
    }

    if (teks.startsWith('/kirim ')) {
        if (!globalSock) return tgBot.sendMessage(TG_GROUP_ID, '⚠️ WA belum siap.', { message_thread_id: threadId });
        const parts = teks.split(' ');
        const noTujuan = parts[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const isi = parts.slice(2).join(' ');
        try {
            await globalSock.sendMessage(noTujuan, { text: isi });
            tgBot.sendMessage(TG_GROUP_ID, `✅ Terkirim.`, { message_thread_id: threadId });
        } catch (e) {
            tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal: ${e.message}`, { message_thread_id: threadId });
        }
    }

    if (teks.startsWith('/gantiwa ')) {
        const parts = teks.split(' ');
        const nomorBaru = parts[1].replace(/[^0-9]/g, '');
        if (!nomorBaru) return tgBot.sendMessage(TG_GROUP_ID, '⚠️ Format: /gantiwa 62812xxxxxxx', { message_thread_id: threadId });

        await tgBot.sendMessage(TG_GROUP_ID, `🔄 *MEMULAI PROSES GANTI NOMOR*\nTarget: ${nomorBaru}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
        nomorWaUtama = nomorBaru;
        await simpanKonfigurasiDB();
        if (globalSock) { try { await globalSock.logout(); } catch (e) {} }
        await authCollection.deleteMany({});
        await delay(2000);
        process.exit(1); // Render akan restart proses otomatis
    }

    if (teks === '/restart') {
        await tgBot.sendMessage(TG_GROUP_ID, `🔄 Memulai ulang server...`, { message_thread_id: threadId });
        process.exit(1);
    }

    if (threadId && globalSock && !teks.startsWith('/')) {
        const wa_id = Object.keys(topikDatabase).find((key) => topikDatabase[key] === threadId);
        if (wa_id) globalSock.sendMessage(wa_id, { text: teks }).catch(() => {});
    }
});

// =========================================================================
// SISTEM ANTREAN TUNGGAL (biar tidak flood Telegram API & aman RAM)
// =========================================================================
async function masukAntrean(infoPesan, isHistory = false) {
    antreanPesan.push({ infoPesan, isHistory });
    if (!sedangMemprosesAntrean) jalankanPekerjaAntrean();
}

async function jalankanPekerjaAntrean() {
    sedangMemprosesAntrean = true;
    while (antreanPesan.length > 0) {
        const { infoPesan, isHistory } = antreanPesan[0];
        await eksekusiKirimKeTelegram(infoPesan, isHistory);
        antreanPesan.shift();

        if (antreanPesan.length % 10 === 0) perbaruiStatusTelegram(statusHpSaatIni);
        await delay(isHistory ? 2000 : 500);
        if (global.gc && antreanPesan.length % 20 === 0) global.gc();
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function pastikanTopik(idPengirim) {
    let threadId = topikDatabase[idPengirim];
    if (threadId) return threadId;

    const isGrup = idPengirim.endsWith('@g.us');
    const namaFolder = isGrup
        ? `👥 GRUP: ${idPengirim.split('@')[0]}`
        : `👤 Kontak (${idPengirim.split('@')[0]})`;

    const result = await safeTG(() => tgBot.createForumTopic(TG_GROUP_ID, namaFolder));
    if (!result) throw new Error('Gagal membuat topik setelah retry');
    threadId = result.message_thread_id;
    topikDatabase[idPengirim] = threadId;
    await simpanKonfigurasiDB();
    return threadId;
}

async function eksekusiKirimKeTelegram(infoPesan, isHistory) {
    const idPengirim = infoPesan.key.remoteJid;
    const tipePesan = Object.keys(infoPesan.message)[0];
    const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';

    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan });

    let threadId;
    try {
        threadId = await pastikanTopik(idPengirim);
    } catch (e) {
        return;
    }

    const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage
        || infoPesan.message.audioMessage || infoPesan.message.documentMessage;
    const awalan = isHistory ? '🕰️ [Riwayat] ' : '💬 ';

    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            if (ukuranBytes > MAX_FILE_SIZE_MB * 1024 * 1024) {
                await safeTG(() => tgBot.sendMessage(TG_GROUP_ID,
                    `⚠️ [Media Dilewati] Mengabaikan file karena ukurannya melebihi ${MAX_FILE_SIZE_MB}MB (demi keamanan RAM server gratisan Render).`,
                    { message_thread_id: threadId }));
                return;
            }
            const streamMedia = await downloadContentFromMessage(pesanMedia, tipePesan.replace('Message', ''));
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);

            await safeTG(() => tgBot.sendDocument(
                TG_GROUP_ID,
                bufferMedia,
                { message_thread_id: threadId, caption: isHistory ? '🕰️ Media lama' : '📂 Media' },
                { filename: `media_${infoPesan.key.id}` }
            ));
        } else if (teksKonten.trim() !== '') {
            await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `${awalan}${teksKonten}`, { message_thread_id: threadId }));
        }
    } catch (e) {
        console.error('[TG SEND ERROR]', e.message);
    }
}

// =========================================================================
// MESIN WHATSAPP UTAMA
// =========================================================================
async function mulaiBotWhatsApp() {
    const { state, saveCreds } = await useMongoDBAuthState();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'), // fingerprint resmi Baileys, lebih stabil utk pairing code
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        emitOwnEvents: true,
        // markOnlineOnConnect dibiarkan default (true) -> presence apa adanya, tidak disembunyikan
        syncFullHistory: false // penting: cegah OOM saat pairing di RAM 512MB, riwayat lama ditarik bertahap
    });

    globalSock = sock;

    // ---- LAZY HISTORY SYNC: dijalankan terjadwal, bukan langsung penuh ----
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
                for (const msg of pesanTerurut) masukAntrean(msg, true);
                await delay(3000); // jeda antar kontak
            }

            sedangSinkronisasi = false;
            perbaruiStatusTelegram(statusHpSaatIni, true);
            setTimeout(jadwalSinkronRiwayat, 60 * 60 * 1000); // ulangi tiap 1 jam kalau ada sisa
        })();
    }, HISTORY_SYNC_DELAY_MS);

    // ---- PAIRING CODE: pemicu utama masalah gagal pairing ada di sini ----
    // Fix 1: tunggu event 'connection.update' dgn qr/connecting dulu, jangan minta kode
    //        sebelum socket benar-benar siap (race condition penyebab error umum).
    // Fix 2: pastikan hanya diminta SEKALI per proses (sudahMemintaKode) supaya tidak
    //        dobel-request saat reconnect cepat, yang sering bikin WA menolak.
    // Fix 3: retry dengan jeda lebih panjang (5 detik, bukan 3) dan hormati rate-limit.
    async function mintaKodePairing(retryCount = 0) {
        try {
            if (!globalSock || sock.authState.creds.registered || sudahMemintaKode) return;
            sudahMemintaKode = true;
            const cleanNumber = nomorWaUtama.replace(/[^0-9]/g, '');

            let kodePairing = await sock.requestPairingCode(cleanNumber);
            kodePairing = kodePairing?.match(/.{1,4}/g)?.join('-') || kodePairing;

            await tgBot.sendMessage(
                TG_GROUP_ID,
                `⚠️ *KODE PAIRING:* \`${kodePairing}\`\nNomor: ${cleanNumber}\n\nBuka WhatsApp di HP > Perangkat Tertaut > Tautkan Perangkat > Tautkan dengan nomor telepon, lalu masukkan kode ini dalam waktu 60 detik.`,
                { parse_mode: 'Markdown' }
            );
        } catch (err) {
            console.error(`[PAIRING ERROR] percobaan ke-${retryCount + 1}:`, err.message, err.stack);
            sudahMemintaKode = false; // izinkan retry
            if (retryCount < 3) {
                setTimeout(() => mintaKodePairing(retryCount + 1), 5000);
            } else {
                tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal mengambil kode pairing setelah 4 kali percobaan.\nAlasan: ${err.message}\nCoba /restart.`);
            }
        }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // LOG DETAIL: setiap perubahan status koneksi dicatat mentah di console
        // (muncul di Render > Logs) supaya kegagalan tidak lagi "diam saja".
        console.log('[CONN UPDATE]', JSON.stringify({
            connection,
            hasQr: !!qr,
            statusCode: lastDisconnect?.error?.output?.statusCode,
            errorMessage: lastDisconnect?.error?.message,
            errorData: lastDisconnect?.error?.data ? JSON.stringify(lastDisconnect.error.data) : undefined
        }));

        // Baru minta kode pairing setelah socket sudah dalam status "connecting"
        // dan belum registered — ini titik yang paling sering diminta terlalu dini.
        if (connection === 'connecting' && !sock.authState.creds.registered && !sedangMenungguPairing && nomorWaUtama) {
            sedangMenungguPairing = true;
            setTimeout(() => mintaKodePairing(0), 2000);
        }

        if (connection === 'close') {
            globalSock = null;
            sedangMenungguPairing = false;
            sudahMemintaKode = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            const alasan = lastDisconnect?.error?.message || 'Tidak diketahui';

            console.log(`[CONN CLOSE] statusCode=${statusCode} isLoggedOut=${isLoggedOut} alasan=${alasan}`);

            if (isLoggedOut) {
                try { await authCollection.deleteMany({}); } catch (e) {}
                perbaruiStatusTelegram(`Logout (${statusCode}) - perlu pairing ulang. Alasan: ${alasan}`, true);
            } else {
                perbaruiStatusTelegram(`Terputus (${statusCode || '?'}), menyambung ulang... Alasan: ${alasan}`, true);
            }

            setTimeout(mulaiBotWhatsApp, 5000);
        } else if (connection === 'open') {
            sedangMenungguPairing = false;
            perbaruiStatusTelegram('Online');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const infoPesan = chatUpdate.messages[0];
        if (!infoPesan || !infoPesan.message) return;

        if (infoPesan.key.fromMe) {
            waktuTerakhirAktif = Date.now();
            // Backup juga pesan yang kita kirim sendiri, supaya percakapan lengkap dua arah
            // tersimpan di Telegram (tanpa dashboard status online/offline perangkat).
            try {
                const idPenerima = infoPesan.key.remoteJid;
                const threadId = await pastikanTopik(idPenerima);
                const teksKeluar = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';
                if (threadId && teksKeluar.trim() !== '') {
                    await safeTG(() => tgBot.sendMessage(TG_GROUP_ID, `📤 (Anda): ${teksKeluar}`, { message_thread_id: threadId }));
                }
            } catch (e) {
                console.error('[BACKUP KELUAR ERROR]', e.message);
            }
            return;
        }

        const idPesan = infoPesan.key.id;
        if (cacheAntiSpam.has(idPesan)) return;
        cacheAntiSpam.set(idPesan, true);

        masukAntrean(infoPesan, false);
    });

    // ---- ANTI-DELETE + DETEKSI EDIT ----
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            const proto = update.update.protocolMessage;
            if (!proto) continue;

            // type 0 = REVOKE (dihapus), type 14 = MESSAGE_EDIT (diedit) di Baileys
            if (proto.type === 0) {
                const idTarget = proto.key.id;
                const dataAsli = cacheAntiDelete.get(idTarget);

                if (dataAsli) {
                    const threadId = topikDatabase[proto.key.remoteJid];
                    if (threadId) {
                        await safeTG(() => tgBot.sendMessage(
                            TG_GROUP_ID,
                            `⚠️ [PESAN DIHAPUS]\n👉 Isi: "${dataAsli.teks || 'Media'}"`,
                            { message_thread_id: threadId }
                        ));
                    }
                }
            } else if (proto.type === 14) {
                const idTarget = proto.key.id;
                const dataAsli = cacheAntiDelete.get(idTarget);
                const teksBaru = proto.editedMessage?.conversation
                    || proto.editedMessage?.extendedTextMessage?.text || '(tidak terbaca)';
                const threadId = topikDatabase[proto.key.remoteJid];

                if (threadId) {
                    await safeTG(() => tgBot.sendMessage(
                        TG_GROUP_ID,
                        `✏️ [PESAN DIEDIT]\n👉 Sebelum: "${dataAsli?.teks || '(tidak tercatat)'}"\n👉 Sesudah: "${teksBaru}"`,
                        { message_thread_id: threadId }
                    ));
                }
                // Perbarui cache supaya pelacakan hapus/edit berikutnya pakai versi terbaru
                if (dataAsli) cacheAntiDelete.set(idTarget, { ...dataAsli, teks: teksBaru });
            }
        }
    });

    // Clear Chat / Delete Chat di HP -> catat saja, jangan hapus apa pun di Telegram
    sock.ev.on('chats.delete', (ids) => {
        console.log('[INFO] chats.delete diterima, diabaikan sengaja agar cadangan Telegram tetap utuh:', ids);
    });
}

// =========================================================================
// EXPRESS SERVER (keep-alive UptimeRobot) & GARBAGE COLLECTOR
// =========================================================================
setInterval(() => {
    if (global.gc) global.gc();
}, 120000);

// Heartbeat berkala ke MongoDB — dibaca oleh Dashboard (deployment terpisah)
// lewat /api/dashboard-status, karena dashboard tidak punya akses langsung
// ke memori proses bot ini.
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
    } catch (e) {
        console.error('[HEARTBEAT ERROR]', e.message);
    }
}, 20000);

const app = express();
app.get('/', (req, res) => res.send('Bot WhatsApp ke Telegram Aktif!'));

process.on('SIGTERM', async () => {
    console.log('[SYS] Sinyal shutdown diterima.');
    if (globalSock) globalSock.end();
    await mongoClient.close();
    process.exit(0);
});

hubungkanDatabase().then(() => {
    app.listen(process.env.PORT || 3000, () => console.log('Web server berjalan.'));
    mulaiBotWhatsApp();
}).catch((e) => {
    console.error('[FATAL] Gagal konek database:', e.message);
    process.exit(1);
});
