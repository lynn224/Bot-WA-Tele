const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { CustomFile } = require('telegram/client/uploads');
const fs = require('fs');

let mtprotoClient = null;
let isConnected = false;

async function inisialisasiMTProto(configCollection, apiId, apiHash, botToken) {
    if (!apiId || !apiHash) {
        console.warn('⚠️ [MTProto] TG_API_ID atau TG_API_HASH belum diatur.');
        return false;
    }

    try {
        const docConfig = await configCollection.findOne({ _id: 'global_settings' });
        const savedSession = docConfig?.tg_mtproto_bot_session || '';
        const stringSession = new StringSession(savedSession);

        mtprotoClient = new TelegramClient(stringSession, Number(apiId), apiHash, {
            connectionRetries: 5,
            useWSS: false,
            autoReconnect: true,
        });

        mtprotoClient.setLogLevel("warn");

        await mtprotoClient.start({
            botAuthToken: botToken,
        });

        if (mtprotoClient._updateLoop) {
            mtprotoClient._updateLoop = async () => {};
        }

        isConnected = true;
        console.log('✅ [MTProto] Terhubung langsung ke Data Center Telegram (Bot Mode).');

        const currentSessionString = mtprotoClient.session.save();
        if (currentSessionString !== savedSession) {
            await configCollection.updateOne(
                { _id: 'global_settings' },
                { $set: { tg_mtproto_bot_session: currentSessionString } },
                { upsert: true }
            );
        }
        return true;
    } catch (e) {
        console.error('❌ [MTProto INIT ERROR]', e.message);
        return false;
    }
}

async function uploadBesarMTProto(filePath, namaFile, mimeType, caption, targetGroupId, threadId) {
    if (!isConnected || !mtprotoClient) {
        throw new Error("Koneksi MTProto belum siap atau gagal.");
    }

    if (!fs.existsSync(filePath)) {
        throw new Error(`File temporer tidak ditemukan: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
        throw new Error("File unduhan kosong (0 bytes).");
    }

    const toUpload = new CustomFile(namaFile, stats.size, filePath);

    const fileHandle = await mtprotoClient.uploadFile({
        file: toUpload,
        workers: 1,
    });

    const inputPeer = await mtprotoClient.getInputEntity(targetGroupId);

    const sendOptions = {
        file: fileHandle,
        caption: caption || '',
        attributes: [
            new Api.DocumentAttributeFilename({ fileName: namaFile })
        ]
    };

    if (threadId) {
        sendOptions.replyTo = Number(threadId);
    }

    const sentMsg = await mtprotoClient.sendFile(inputPeer, sendOptions);
    return { message_id: sentMsg.id };
}

module.exports = { inisialisasiMTProto, uploadBesarMTProto };
