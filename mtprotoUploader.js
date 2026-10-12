const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const fs = require('fs');

let mtprotoClient = null;
let isConnected = false;

async function inisialisasiMTProto(configCollection, apiId, apiHash, botToken) {
    if (!apiId || !apiHash) {
        console.warn('⚠️ [MTProto] TG_API_ID atau TG_API_HASH belum diatur. Bypass media besar >50MB tidak aktif.');
        return false;
    }

    try {
        const docConfig = await configCollection.findOne({ _id: 'global_settings' });
        const savedSession = docConfig?.tg_mtproto_bot_session || '';
        const stringSession = new StringSession(savedSession);

        // Koneksi TCP murni untuk hemat RAM (useWSS: false)
        mtprotoClient = new TelegramClient(stringSession, Number(apiId), apiHash, {
            connectionRetries: 5,
            useWSS: false,
        });

        await mtprotoClient.start({
            botAuthToken: botToken,
        });

        isConnected = true;
        console.log('✅ [MTProto] Terhubung langsung ke Data Center Telegram (Bot Mode).');

        // Cadangkan sesi ke MongoDB
        const currentSessionString = mtprotoClient.session.save();
        if (currentSessionString !== savedSession) {
            await configCollection.updateOne(
                { _id: 'global_settings' },
                { $set: { tg_mtproto_bot_session: currentSessionString } },
                { upsert: true }
            );
            console.log('[MTProto] String Sesi Bot berhasil diamankan ke MongoDB.');
        }
        return true;
    } catch (e) {
        console.error('❌ [MTProto ERROR]', e.message);
        return false;
    }
}

async function uploadBesarMTProto(filePath, namaFile, mimeType, caption, targetGroupId, threadId) {
    if (!isConnected || !mtprotoClient) throw new Error("Koneksi MTProto belum siap atau gagal.");

    const stats = fs.statSync(filePath);
    const toUpload = new CustomFile(namaFile, stats.size, filePath);

    // KUNCI OPTIMASI RAM: workers = 1 agar chunk memory minimal
    const fileHandle = await mtprotoClient.uploadFile({
        file: toUpload,
        workers: 1, 
    });

    const groupIdNum = typeof targetGroupId === 'string' ? Number(targetGroupId) : targetGroupId;

    const sentMsg = await mtprotoClient.sendFile(groupIdNum, {
        file: fileHandle,
        caption: caption,
        replyTo: threadId,
        parseMode: 'markdown',
        attributes: [
            new Api.DocumentAttributeFilename({ fileName: namaFile })
        ]
    });

    return { message_id: sentMsg.id }; 
}

module.exports = { inisialisasiMTProto, uploadBesarMTProto };
