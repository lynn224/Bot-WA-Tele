const { default: makeWASocket, DisconnectReason, downloadContentFromMessage, initAuthCreds, BufferJSON, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
let nomorWaUtama = process.env.NOMOR_WA_UTAMA; 

const MAX_FILE_SIZE_MB = 5;
const tgBot = new TelegramBot(TG_TOKEN, { polling: true }); 

const cacheAntiSpam = new NodeCache({ stdTTL: 3600 }); 
const cacheAntiDelete = new NodeCache({ stdTTL: 86400 }); 

let globalSock = null;
let sedangMenungguPairing = false;
let topikDatabase = {};
let idPesanStatus = null;

global.stealthMode = true; 
global.mesinBerhenti = false; 

let statusHpSaatIni = 'Offline'; 
let waktuTerakhirAktif = 0; 
let sedangMemprosesAntrean = false;
let sedangSinkronisasi = false;
const antreanPesan = [];

// =========================================================================
// MONGODB ADAPTER
// =========================================================================
const mongoClient = new MongoClient(MONGODB_URI);
let db, authCollection, configCollection;

async function hubungkanDatabase() {
    await mongoClient.connect();
    db = mongoClient.db('wa_siluman_db');
    authCollection = db.collection('auth_sessions');
    configCollection = db.collection('bot_config');
    
    console.log('[DB] MongoDB Berhasil Terhubung!');
    
    const config = await configCollection.findOne({ _id: 'global_settings' });
    if (config) {
        topikDatabase = config.topik || {};
        idPesanStatus = config.pinned_status_msg_id || null;
        if (config.stealthMode !== undefined) global.stealthMode = config.stealthMode;
        if (config.nomor_wa_utama) nomorWaUtama = config.nomor_wa_utama; 
    }
}

async function simpanKonfigurasiDB() {
    await configCollection.updateOne(
        { _id: 'global_settings' },
        { $set: { 
            topik: topikDatabase, 
            pinned_status_msg_id: idPesanStatus, 
            stealthMode: global.stealthMode,
            nomor_wa_utama: nomorWaUtama
        }},
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
                    await Promise.all(ids.map(async id => {
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
// COMMAND CENTER TELEGRAM
// =========================================================================
async function perbaruiStatusTelegram(statusBaru) {
    if (statusHpSaatIni === statusBaru && idPesanStatus && antreanPesan.length === 0 && !sedangSinkronisasi) return;
    statusHpSaatIni = statusBaru;
    
    const mode = global.stealthMode ? '👻 AKTIF (Centang 1)' : '👀 MATI (Normal)';
    let teksStatus = `🖥️ **COMMAND CENTER**\n\n📱 Status WhatsApp: **${global.mesinBerhenti ? '🛑 DIMATIKAN' : statusBaru}**\n🛡️ Mode Siluman: ${mode}\n📦 Antrean Pesan: ${antreanPesan.length}`;
    if (sedangSinkronisasi) teksStatus += `\n⏳ Sinkronisasi riwayat berjalan...`;
    
    try {
        if (idPesanStatus) {
            await tgBot.editMessageText(teksStatus, { chat_id: TG_GROUP_ID, message_id: idPesanStatus, parse_mode: 'Markdown' });
        } else {
            const msg = await tgBot.sendMessage(TG_GROUP_ID, teksStatus, { parse_mode: 'Markdown' });
            idPesanStatus = msg.message_id;
            simpanKonfigurasiDB();
            await tgBot.pinChatMessage(TG_GROUP_ID, idPesanStatus, { disable_notification: true });
        }
    } catch (e) { idPesanStatus = null; }
}

tgBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TG_GROUP_ID || msg.from.is_bot) return;
    const teks = msg.text || '';
    const threadId = msg.message_thread_id;

    if (teks === '/help') {
        const help = `🛠️ **MENU**\n/status - Diagnostik\n/siluman [on/off] - Mode Centang 1\n/kirim [no] [pesan] - Kirim WA\n/gantiwa [no] - Ganti Nomor\n/stop - Matikan WA\n/start - Nyalakan WA\n/restart - Reboot Server`;
        return tgBot.sendMessage(TG_GROUP_ID, help, { message_thread_id: threadId });
    }

    if (teks === '/stop') {
        global.mesinBerhenti = true;
        if (globalSock) globalSock.end();
        perbaruiStatusTelegram('Offline');
        return tgBot.sendMessage(TG_GROUP_ID, '🛑 **Mesin WA dimatikan.**\nKetik `/start` untuk menghidupkan.', { message_thread_id: threadId, parse_mode: 'Markdown' });
    }

    if (teks === '/start') {
        if (!global.mesinBerhenti) return tgBot.sendMessage(TG_GROUP_ID, '⚠️ Mesin sudah nyala.', { message_thread_id: threadId });
        global.mesinBerhenti = false;
        tgBot.sendMessage(TG_GROUP_ID, '✅ **Menyalakan ulang mesin WA...**', { message_thread_id: threadId, parse_mode: 'Markdown' });
        mulaiBotWhatsApp();
        return;
    }

    if (teks === '/restart') {
        await tgBot.sendMessage(TG_GROUP_ID, `🔄 Memulai ulang server...`, { message_thread_id: threadId });
        process.exit(1); 
    }

    if (teks === '/status') {
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        return tgBot.sendMessage(TG_GROUP_ID, `📊 RAM: ${ram} MB\n🔌 WA: ${globalSock ? 'Konek' : 'Putus'}\n📥 Antrean: ${antreanPesan.length}`, { message_thread_id: threadId });
    }

    if (teks.startsWith('/siluman ')) {
        const cmd = teks.split(' ')[1].toLowerCase();
        if (cmd === 'on' || cmd === 'off') {
            global.stealthMode = (cmd === 'on');
            simpanKonfigurasiDB();
            perbaruiStatusTelegram(statusHpSaatIni);
            return tgBot.sendMessage(TG_GROUP_ID, `✅ Mode Siluman: **${cmd.toUpperCase()}**`, { message_thread_id: threadId, parse_mode: 'Markdown' });
        }
    }

    if (teks.startsWith('/kirim ')) {
        if (!globalSock) return tgBot.sendMessage(TG_GROUP_ID, '⚠️ WA belum siap!', { message_thread_id: threadId });
        const parts = teks.split(' ');
        let noTujuan = parts[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const isi = parts.slice(2).join(' ');
        try {
            await globalSock.sendMessage(noTujuan, { text: isi });
            tgBot.sendMessage(TG_GROUP_ID, `✅ Terkirim!`, { message_thread_id: threadId });
        } catch (e) {}
    }

    if (teks.startsWith('/gantiwa ')) {
        const parts = teks.split(' ');
        const nomorBaru = parts[1].replace(/[^0-9]/g, ''); 
        await tgBot.sendMessage(TG_GROUP_ID, `🔄 **MEMULAI PROSES GANTI NOMOR**\nTarget: ${nomorBaru}`, { message_thread_id: threadId, parse_mode: 'Markdown' });
        nomorWaUtama = nomorBaru;
        await simpanKonfigurasiDB();
        if (globalSock) { try { await globalSock.logout(); } catch (e) {} }
        await authCollection.deleteMany({});
        await delay(2000); 
        process.exit(1); 
    }
    
    if (threadId && globalSock && !teks.startsWith('/')) {
        const wa_id = Object.keys(topikDatabase).find(key => topikDatabase[key] === threadId);
        if (wa_id) globalSock.sendMessage(wa_id, { text: teks }).catch(() => {});
    }
});

// =========================================================================
// SISTEM ANTREAN TUNGGAL
// =========================================================================
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function eksekusiKirimKeTelegram(infoPesan, isHistory) {
    const idPengirim = infoPesan.key.remoteJid;
    const tipePesan = Object.keys(infoPesan.message)[0];
    let teksKonten = infoPesan.message.conversation || infoPesan.message.extendedTextMessage?.text || "";
    cacheAntiDelete.set(infoPesan.key.id, { teks: teksKonten, tipe: tipePesan });
    
    let threadId = topikDatabase[idPengirim];
    if (!threadId) {
        const isGrup = idPengirim.endsWith('@g.us');
        let namaFolder = isGrup ? `👥 GRUP: ${idPengirim.split('@')[0]}` : `👤 Kontak (${idPengirim.split('@')[0]})`;
        try {
            const result = await tgBot.createForumTopic(TG_GROUP_ID, namaFolder);
            threadId = result.message_thread_id;
            topikDatabase[idPengirim] = threadId;
            simpanKonfigurasiDB();
        } catch(e) { return; } 
    }
    
    const pesanMedia = infoPesan.message.imageMessage || infoPesan.message.videoMessage || infoPesan.message.audioMessage || infoPesan.message.documentMessage;
    const awalan = isHistory ? '🕰️ [Riwayat] ' : '💬 ';
    
    try {
        if (pesanMedia) {
            if (parseInt(pesanMedia.fileLength || 0) > MAX_FILE_SIZE_MB * 1024 * 1024) return;
            const streamMedia = await downloadContentFromMessage(pesanMedia, tipePesan.replace('Message', ''));
            let bufferMedia = Buffer.alloc(0);
            for await (const chunk of streamMedia) bufferMedia = Buffer.concat([bufferMedia, chunk]);
            await tgBot.sendDocument(TG_GROUP_ID, bufferMedia, { message_thread_id: threadId, caption: isHistory ? '🕰️ Media' : '📂 Media' }, { filename: `media_${infoPesan.key.id}` });
        } else if (teksKonten.trim() !== "") {
            await tgBot.sendMessage(TG_GROUP_ID, `${awalan}${teksKonten}`, { message_thread_id: threadId });
        }
    } catch (e) {}
}

// =========================================================================
// MESIN WHATSAPP UTAMA 
// =========================================================================
async function mulaiBotWhatsApp() {
    if (global.mesinBerhenti) return;

    const { state, saveCreds } = await useMongoDBAuthState();
    
    // PERBAIKAN KRUSIAL 1: Mengambil versi WA Web terbaru langsung dari server Meta
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[SYS] Menggunakan WA v${version.join('.')} (Terbaru: ${isLatest})`);

    const sock = makeWASocket({
        version, // Wajib diisi agar Meta tidak menolak permintaan kode
        auth: state,
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false, // PERBAIKAN KRUSIAL 2: Matikan paksa fitur QR
        syncFullHistory: true,
        browser: ['Mac OS', 'Safari', '10.15.7'] 
    });
    
    globalSock = sock; 

    // BLOK FILTER ACK DINAMIS
    if (typeof sock.sendNode === 'function') {
        const eksekusiAsliSendNode = sock.sendNode;
        sock.sendNode = function (node) {
            if (global.stealthMode && node.tag === 'receipt' && (node.attrs?.type === 'delivery' || node.attrs?.type === 'read')) {
                return Promise.resolve(); 
            }
            return eksekusiAsliSendNode.apply(this, arguments);
        };
    }

    sock.ev.on('messaging-history.set', async ({ messages }) => { 
        if (!messages || messages.length === 0) return;
        sedangSinkronisasi = true;
        perbaruiStatusTelegram(statusHpSaatIni);
        
        const pesanTerurut = messages.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
        for (const msg of pesanTerurut) {
            if (!msg.message || msg.key.fromMe) continue;
            masukAntrean(msg, true);
        }
        sedangSinkronisasi = false;
    });

    // SISTEM PENGHASIL KODE PAIRING (DENGAN PENANGKAP ERROR)
    if (!sock.authState.creds.registered && !sedangMenungguPairing) {
        sedangMenungguPairing = true;
        
        const cleanNumber = nomorWaUtama.replace(/[^0-9]/g, '');
        tgBot.sendMessage(TG_GROUP_ID, `⏳ *Menghubungkan ke Meta (v${version.join('.')})...*`, { parse_mode: 'Markdown' });

        setTimeout(async () => {
            try {
                const kodePairing = await sock.requestPairingCode(cleanNumber);
                tgBot.sendMessage(TG_GROUP_ID, `⚠️ **KODE PAIRING BARU:** \`${kodePairing}\`\nNomor: ${cleanNumber}\n\n_Auto-restart dalam 3 menit jika gagal._`, { parse_mode: 'Markdown' });
                
                setTimeout(() => {
                    if (globalSock && !sock.authState.creds.registered && !global.mesinBerhenti) {
                        tgBot.sendMessage(TG_GROUP_ID, `🔄 Waktu tautan habis. Merestart mesin...`);
                        process.exit(1); 
                    }
                }, 180000); 

            } catch (err) { 
                sedangMenungguPairing = false;
                // PERBAIKAN KRUSIAL 3: Mencetak alasan asli penolakan
                const errorMsg = err.message || 'Tidak diketahui';
                console.error('[PAIRING ERROR]', err);
                
                if (errorMsg.includes('429') || errorMsg.includes('rate-overlimit')) {
                    tgBot.sendMessage(TG_GROUP_ID, `❌ **DIBLOKIR SEMENTARA (Error 429)**\nIP Render Anda sedang dibatasi oleh Meta karena terlalu sering meminta kode. Harap matikan bot (ketik \`/stop\`) dan tunggu 1-2 jam sebelum mencoba \`/start\` kembali.`);
                } else {
                    tgBot.sendMessage(TG_GROUP_ID, `❌ **Gagal mengambil kode:**\n\`${errorMsg}\`\nMesin akan mencoba ulang...`, { parse_mode: 'Markdown' });
                }
            }
        }, 5000); 
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            globalSock = null; 
            if (!global.mesinBerhenti && (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
                mulaiBotWhatsApp();
            }
        } else if (connection === 'open') {
            sedangMenungguPairing = false; 
            await sock.sendPresenceUpdate('unavailable');
            perbaruiStatusTelegram('Offline');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        const infoPesan = chatUpdate.messages[0];
        if (!infoPesan || !infoPesan.message) return;
        
        if (infoPesan.key.fromMe) {
            waktuTerakhirAktif = Date.now();
            perbaruiStatusTelegram('Online');
            return;
        }

        const idPesan = infoPesan.key.id;
        if (cacheAntiSpam.has(idPesan)) return; 
        cacheAntiSpam.set(idPesan, true); 
        
        masukAntrean(infoPesan, false);
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update.protocolMessage && update.update.protocolMessage.type === 0) {
                const idTarget = update.update.protocolMessage.key.id;
                const dataAsli = cacheAntiDelete.get(idTarget); 
                if (dataAsli) {
                    const threadId = topikDatabase[update.update.protocolMessage.key.remoteJid]; 
                    if (threadId) await tgBot.sendMessage(TG_GROUP_ID, `⚠️ [PESAN DIHAPUS]\n👉 Isi: "${dataAsli.teks || 'Media'}"`, { message_thread_id: threadId });
                }
            }
            if (update.update.status === 3 || update.update.status === 4) {
                waktuTerakhirAktif = Date.now();
                perbaruiStatusTelegram('Online');
            }
        }
    });
}

// =========================================================================
// EXPRESS SERVER
// =========================================================================
setInterval(() => {
    if (global.gc) global.gc();
    if (!global.mesinBerhenti && statusHpSaatIni === 'Online' && (Date.now() - waktuTerakhirAktif > 900000)) {
        perbaruiStatusTelegram('Offline');
    }
}, 120000);

const app = express();
app.get('/', (req, res) => res.send('WhatsApp Command Center - Aktif.'));

process.on('SIGTERM', async () => {
    console.log('[SYS] Sinyal Shutdown Diterima.');
    if (globalSock) globalSock.end();
    await mongoClient.close();
    process.exit(0);
});

hubungkanDatabase().then(() => {
    app.listen(process.env.PORT || 3000, () => console.log('Web Server Berjalan'));
    mulaiBotWhatsApp();
});
