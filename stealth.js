// =========================================================================
// STEALTH ENGINE (Modul Privasi Mutlak - Phantom Node)
// Menangani manipulasi jaringan & XML Stanza tingkat rendah
// =========================================================================

let timerJitter = null;

function terapkanStealthFirewall(sock, dbConfig) {
    const sendNodeAsli = sock.sendNode.bind(sock);
    
    sock.sendNode = async (stanza) => {
        let cegat = false;
        let blokirMutlak = false;
        
        if (dbConfig.stealthMode) {
            if (stanza) {
                // Tangkap indikator online dan mengetik
                if (stanza.tag === 'presence') cegat = true;
                if (stanza.tag === 'chatstate') {
                    cegat = true;
                    blokirMutlak = true;
                }
                // Tangkap semua jenis tanda baca / tanda terima
                if (stanza.tag === 'receipt') cegat = true;
            }
        }
        
        if (cegat) {
            // 1. BLOKIR CHATSTATE (Anti-Mengetik / Merekam)
            if (blokirMutlak) return; 

            // 2. SMART DPI PRESENCE (Hanya izinkan 'unavailable' lewat)
            if (stanza.tag === 'presence') {
                let isOffline = false;
                if (stanza.attrs) {
                    if (stanza.attrs.type === 'unavailable') {
                        isOffline = true;
                    }
                }
                if (!isOffline) return; // Bunuh paket online/available
            }

            // 3. CENTANG 1 MUTLAK & ANTI-BLUE MIC
            if (stanza.tag === 'receipt') {
                const attrs = stanza.attrs;
                let finalCegat = false;
                
                if (attrs) {
                    // Blokir Tanda Baca & Voice Note
                    if (attrs.type === 'read') finalCegat = true;
                    if (attrs.type === 'read-self') finalCegat = true;
                    if (attrs.type === 'played') finalCegat = true; 
                    
                    // Blokir Tanda Terima (Delivery = Centang 1 Mutlak)
                    if (attrs.type === 'delivery') finalCegat = true;
                    if (attrs.type === 'sender') finalCegat = true;
                    if (attrs.type === 'inactive') finalCegat = true;
                    
                    // Deteksi receipt tanpa tipe (typeless = otomatis delivery)
                    let hasType = false;
                    if (attrs.type) hasType = true;
                    if (!hasType) finalCegat = true; 

                    // Ghost Viewer Status (Anti-tercatat melihat story)
                    if (attrs.to) {
                        if (attrs.to.includes('status@broadcast')) {
                            finalCegat = true; 
                        }
                    }
                } else {
                    finalCegat = true; // Jika tidak ada atribut sama sekali, buang
                }

                if (finalCegat) return; 
            }
        }
        return await sendNodeAsli(stanza);
    };
}

// Fitur Beacon Jittering (Detak Jantung Acak 1 - 20 Detik)
function jalankanBeaconJittering(sock, dbConfig) {
    if (timerJitter) clearTimeout(timerJitter);

    const loopAcak = async () => {
        if (dbConfig.stealthMode) {
            if (sock) {
                if (sock.ws) {
                    if (sock.ws.isOpen) {
                        try { await sock.sendPresenceUpdate('unavailable'); } catch (e) {}
                    }
                }
            }
        }
        // Kalkulasi waktu acak murni antara 1000 ms s/d 20000 ms (1-20 detik)
        const waktuAcakMs = Math.floor(Math.random() * 19000) + 1000;
        timerJitter = setTimeout(loopAcak, waktuAcakMs);
    };
    
    // Mulai siklus acak
    loopAcak();
}

function hentikanBeaconJittering() {
    if (timerJitter) clearTimeout(timerJitter);
    timerJitter = null;
}

// Fitur Tembakan Paksa Offline JIT (Just-In-Time) - Bom Asap
async function tembakOfflineJIT(sock, dbConfig) {
    if (dbConfig.stealthMode) {
        if (sock) {
            if (sock.ws) {
                if (sock.ws.isOpen) {
                    try { await sock.sendPresenceUpdate('unavailable'); } catch (e) {}
                }
            }
        }
    }
}

// Fitur Pelepas Centang Biru Manual
async function paksaCentangBiru(sock, targetJid, cacheLastMsg) {
    const lastMsg = cacheLastMsg.get(targetJid);
    if (!lastMsg) throw new Error('Tidak ada pesan terakhir yang tersimpan di memori.');
    await sock.readMessages([lastMsg.key]);
}

module.exports = {
    terapkanStealthFirewall,
    jalankanBeaconJittering,
    hentikanBeaconJittering,
    tembakOfflineJIT,
    paksaCentangBiru
};
