// =========================================================================
// PENANGKAL CRASH GLOBAL (Anti-Badai Jaringan)
// =========================================================================
process.on('uncaughtException', (err) => console.log('[ANTI-CRASH] Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.log('[ANTI-CRASH] Unhandled Rejection:', reason));

const {
    default: makeWASocket,
    DisconnectReason,
    downloadContentFromMessage,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const pino = require('pino');
const NodeCache = require('node-cache');
const { MongoClient } = require('mongodb');
const fs = require('fs');

// =========================================================================
// KONFIGURASI LINGKUNGAN
// =========================================================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_GROUP_ID = process.env.TG_GROUP_ID;
const MONGODB_URI = process.env.MONGODB_URI;
let nomorWaUtama = process.env.NOMOR_WA_UTAMA; 

const MAX_FILE_SIZE_MB = 5;
const HISTORY_SYNC_DELAY_MS = 15 * 60 * 1000; 
const HISTORY_BATCH_SIZE = 40; 

if (!TG_TOKEN || !TG_GROUP_ID || !MONGODB_URI || !nomorWaUtama) {
    console.error('[FATAL] Variabel lingkungan belum lengkap.');
    process.exit(1);
}

// Menjinakkan Error Jaringan Telegram
const tgBot = new TelegramBot(TG_TOKEN, { 
    polling: true,
    request: { timeout: 30000 } 
});
tgBot.on('polling_error', () => {}); // Bungkam pesan error EFATAL dari Telegram

const cacheAntiSpam = new NodeCache({ stdTTL: 3600 });
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 });

let globalSock = null;
let sedangMenungguPairing = false;
let sudahMemintaKode = false;
let topikDatabase = {};
let idPesanStatus = null;

global.stealthMode = true; 

let statusHpSaatIni = 'Menghubungkan...';
let waktuTerakhirAktif = 0;
let sedangMemprosesAntrean = false;
let sedangSinkronisasi = false;
const antreanPesan = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =========================================================================
// MONGODB ADAPTER
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
        if (config.stealthMode !== undefined) global.stealthMode = config.stealthMode;
    }
}

async function simpanKonfigurasiDB() {
    try {
        await configCollection.updateOne(
            { _id: 'global_settings' },
            { $set: { topik: topikDatabase, pinned_status_msg_id: idPesanStatus, nomor_wa_utama: nomorWaUtama, stealthMode: global.stealthMode } },
            { upsert: true }
        );
    } catch (e) {}
}

// ARSITEKTUR HYBRID: LOKAL -> CLOUD (Kebal Putus Jaringan)
async function prepareHybridSession() {
    const sessionDir = 'session_baileys';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir);

    try {
        const dbDocs = await authCollection.find({}).toArray();
        if (dbDocs.length > 0) {
            for (const doc of dbDocs) {
                fs.writeFileSync(`${sessionDir}/${doc._id}.json`, JSON.stringify(doc.data));
            }
        }
    } catch (e) {
        console.log('[WARN] Jaringan tidak stabil saat membaca DB. Sesi akan mengandalkan file lokal...');
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const syncToCloud = async () => {
        try {
            const files = fs.readdirSync(sessionDir);
            const operations = [];
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const _id = file.replace('.json', '');
                    const rawText = fs.readFileSync(`${sessionDir}/${file}`, 'utf-8');
                    const data = JSON.parse(rawText);
                    operations.push({ updateOne: { filter: { _id }, update: { $set: { data } }, upsert: true } });
                }
            }
            if (operations.length > 0) {
                await authCollection.bulkWrite(operations, { ordered: false });
            }
        } catch (e) {}
    };

    setInterval(syncToCloud, 120000);

    return { state, saveCreds, syncToCloud };
}

// =========================================================================
// COMMAND CENTER TELEGRAM
// =========================================================================
async function perbaruiStatusTelegram(statusBaru, paksa = false) {
    if (!paksa && statusHpSaatIni === statusBaru && idPesanStatus && antreanPesan.length === 0 && !sedangSinkronisasi) return;
    statusHpSaatIni = statusBaru;

    const mode = global.stealthMode ? '👻 AKTIF (Centang 1)' : '👀 MATI (Normal)';
    let teksStatus = `🖥️ *COMMAND CENTER*\n\n📱 Status Koneksi: *${statusBaru}*\n🛡️ Mode Siluman: ${mode}\n📦 Antrean Pesan: ${antreanPesan.length}`;
    if (sedangSinkronisasi) teksStatus += `\n⏳ Sinkronisasi riwayat lama berjalan...`;

    try {
        if (idPesanStatus) {
            await tgBot.editMessageText(teksStatus, { chat_id: TG_GROUP_ID, message_id: idPesanStatus, parse_mode: 'Markdown' });
        } else {
            const msg = await tgBot.sendMessage(TG_GROUP_ID, teksStatus, { parse_mode: 'Markdown' });
            idPesanStatus = msg.message_id;
            await simpanKonfigurasiDB();
            await tgBot.pinChatMessage(TG_GROUP_ID, idPesanStatus, { disable_notification: true });
        }
    } catch (e) { idPesanStatus = null; }
}

tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    const teks = msg.text || '';
    const threadId = msg.message_thread_id;

    if (teks === '/help') {
        const help = `🛠️ *MENU COMMAND*\n/status - Diagnostik\n/siluman [on/off] - Centang 1\n/kirim [nomor] [pesan] - Kirim WA\n/gantiwa [nomor] - Ganti nomor\n/restart - Restart`;
        return tgBot.sendMessage(TG_GROUP_ID, help, { message_thread_id: threadId, parse_mode: 'Markdown' });
    }

    if (teks === '/status') {
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        return tgBot.sendMessage(TG_GROUP_ID, `📊 RAM: ${ram} MB\n🔌 WA: ${globalSock ? 'Terhubung' : 'Terputus'}`, { message_thread_id: threadId });
    }
    
    if (teks.startsWith('/siluman ')) {
        const cmd = teks.split(' ')[1].toLowerCase();
        if (cmd === 'on' || cmd === 'off') {
            global.stealthMode = (cmd === 'on');
            simpanKonfigurasiDB();
            perbaruiStatusTelegram(statusHpSaatIni, true);
            return tgBot.sendMessage(TG_GROUP_ID, `✅ Mode Siluman: **${cmd.toUpperCase()}**`, { message_thread_id: threadId, parse_mode: 'Markdown' });
        }
    }

    if (teks.startsWith('/kirim ')) {
        if (!globalSock) return tgBot.sendMessage(TG_GROUP_ID, '⚠️ WA belum siap.', { message_thread_id: threadId });
        const parts = teks.split(' ');
        const noTujuan = parts[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const isi = parts.slice(2).join(' ');
        try {
            await globalSock.sendMessage(noTujuan, { text: isi });
            tgBot.sendMessage(TG_GROUP_ID, `✅ Terkirim.`, { message_thread_id: threadId });
        } catch (e) { tgBot.sendMessage(TG_GROUP_ID, `❌ Gagal: ${e.message}`, { message_thread_id: threadId }); }
    }

    if (teks.startsWith('/gantiwa ')) {
        const parts = teks.split(' ');
        const nomorBaru = parts[1].replace(/[^0-9]/g, '');
        if (!nomorBaru) return;

        await tgBot.sendMessage(TG_GROUP_ID, `🔄 *PROSES GANTI NOMOR*\nTarget: ${nomorBaru}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
        nomorWaUtama = nomorBaru;
        await simpanKonfigurasiDB();
        if (globalSock) { try { await globalSock.logout(); } catch (e) {} }
        await authCollection.deleteMany({});
        if (fs.existsSync('session_baileys')) fs.rmSync('session_baileys', { recursive: true, force: true });
        await delay(2000);
        process.exit(1); 
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
// SISTEM ANTREAN TUNGGAL 
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
    }
    sedangMemprosesAntrean = false;
    perbaruiStatusTelegram(statusHpSaatIni);
}

async function pastikanTopik(idPengirim) {
    let threadId = topikDatabase[idPengirim];
    if (threadId) return threadId;
    const isGrup = idPengirim.endsWith('@g.us');
    const namaFolder = isGrup ? `👥 GRUP: ${idPengirim.split('@')[0]}` : `👤 Kontak (${idPengirim.split('@')[0]})`;
    try {
        const result = await tgBot.createForumTopic(TG_GROUP_ID, namaFolder);
        threadId = result.message_thread_id;
        topikDatabase[idPengirim] = threadId;
        await simpanKonfigurasiDB();
        return threadId;
    } catch (e) { return null; }
}

async function eksekusiKirimKeTelegram(infoPesan, isHistory) {
    const idPengirim = infoPesan.key.remoteJid;
    const tipePesan = Object.keys(infoPesan.message)[0];
    const teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || '';
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan });
    const threadId = await pastikanTopik(idPengirim);
    if (!threadId) return;
    const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage || infoPesan.message.audioMessage || infoPesan.message.documentMessage;
    const awalan = isHistory ? '🕰️ [Riwayat] ' : '💬 ';
    try {
        if (pesanMedia) {
            const ukuranBytes = parseInt(pesanMedia.fileLength || 0);
            if (ukuranBytes > MAX_FILE_SIZE_MB * 1024 * 1024) return;
            const streamMedia = await downloadContentFromMessage(pesanMedia, tipePesan.replace('Message', ''));
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);
            await tgBot.sendDocument(TG_GROUP_ID, bufferMedia, { message_thread_id: threadId, caption: isHistory ? '🕰️ Media lama' : '📂 Media' }, { filename: `media_${infoPesan.key.id}` });
        } else if (teksKonten.trim() !== '') {
            await tgBot.sendMessage(TG_GROUP_ID, `${awalan}${teksKonten}`, { message_thread_id: threadId });
        }
    } catch (e) {}
}

// =========================================================================
// MESIN WHATSAPP UTAMA
// =========================================================================
async function mulaiBotWhatsApp() {
    const { state, saveCreds, syncToCloud } = await prepareHybridSession();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state, 
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        connectTimeoutMs: 60000,
        emitOwnEvents: true,
        markOnlineOnConnect: true,
        syncFullHistory: false 
    });

    globalSock = sock;

    if (typeof sock.sendNode === 'function') {
        const eksekusiAsliSendNode = sock.sendNode;
        sock.sendNode = function (node) {
            if (global.stealthMode && node.tag === 'receipt' && (node.attrs?.type === 'delivery' || node.attrs?.type === 'read')) {
                return Promise.resolve();
            }
            return eksekusiAsliSendNode.apply(this, arguments);
        };
    }

    sock.ev.on('creds.update', saveCreds);

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
                await delay(3000); 
            }

            sedangSinkronisasi = false;
            perbaruiStatusTelegram(statusHpSaatIni, true);
            setTimeout(jadwalSinkronRiwayat, 60 * 60 * 1000); 
        })();
    }, HISTORY_SYNC_DELAY_MS);

    async function mintaKodePairing(retryCount = 0) {
        try {
            if (!globalSock || sock.authState.creds.registered || sudahMemintaKode) return;
            sudahMemintaKode = true;
            const cleanNumber = nomorWaUtama.replace(/[^0-9]/g, '');

            console.log(`[SYS] Sedang meminta kode untuk nomor: ${cleanNumber}...`);

            let kodePairing = await sock.requestPairingCode(cleanNumber);
            kodePairing = kodePairing?.match(/.{1,4}/g)?.join('-') || kodePairing;
            
            console.log(`\n==============================================`);
            console.log(`🔑 KODE PAIRING ANDA: ${kodePairing}`);
            console.log(`📱 Untuk Nomor: ${cleanNumber}`);
            console.log(`==============================================\n`);

            await tgBot.sendMessage(TG_GROUP_ID, `⚠️ *KODE PAIRING:* \`${kodePairing}\`\nNomor: ${cleanNumber}\n\nMasukkan kode ini di HP Anda.`, { parse_mode: 'Markdown' }).catch(()=>{});
        } catch (err) {
            sudahMemintaKode = false; 
            console.log(`[ERROR WA] Gagal meminta kode:`, err.message);
            if (retryCount < 5) {
                console.log(`[SYS] Mencoba lagi dalam 5 detik... (Percobaan ${retryCount + 1}/5)`);
                setTimeout(() => mintaKodePairing(retryCount + 1), 5000);
            }
        }
    }

    if (!sock.authState.creds.registered) {
        setTimeout(() => mintaKodePairing(0), 4000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            globalSock = null;
            sedangMenungguPairing = false;
            sudahMemintaKode = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                try { 
                    await authCollection.deleteMany({}); 
                    if (fs.existsSync('session_baileys')) fs.rmSync('session_baileys', { recursive: true, force: true });
                } catch (e) {}
                perbaruiStatusTelegram('Logout - perlu pairing ulang', true);
            } else {
                perbaruiStatusTelegram('Terputus, menyambung ulang...', true);
            }
            setTimeout(mulaiBotWhatsApp, 5000);
        } else if (connection === 'open') {
            sedangMenungguPairing = false;
            perbaruiStatusTelegram('Online');
            console.log('\n✅ BERHASIL TAUTAN! Menyinkronkan kunci ke Cloud...\n');
            await syncToCloud(); 
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const infoPesan = chatUpdate.messages[0];
        if (!infoPesan || !infoPesan.message || infoPesan.key.fromMe) return;
        const idPesan = infoPesan.key.id;
        if (cacheAntiSpam.has(idPesan)) return;
        cacheAntiSpam.set(idPesan, true);
        masukAntrean(infoPesan, false);
    });
}

// =========================================================================
// EXPRESS SERVER & GARBAGE COLLECTOR
// =========================================================================
setInterval(() => { if (global.gc) global.gc(); }, 120000);
const app = express();
app.get('/', (req, res) => res.send('Bot Aktif!'));

hubungkanDatabase().then(() => {
    app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Web server berjalan.'));
    mulaiBotWhatsApp();
}).catch((e) => { process.exit(1); });
