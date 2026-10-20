// =========================================================================
// STEALTH ENGINE (Modul Privasi Mutlak - Phantom Node)
// Menangani manipulasi jaringan & XML Stanza tingkat rendah
// =========================================================================

let timerJitter = null;
let sedangBypassRead = false;

function terapkanStealthFirewall(sock, dbConfig) {
    const sendNodeAsli = sock.sendNode.bind(sock);
    
    sock.sendNode = async (stanza) => {
        let cegat = false;
        let blokirMutlak = false;
        
        if (dbConfig.stealthMode) {
            if (stanza) {
                if (stanza.tag === 'presence') cegat = true;
                if (stanza.tag === 'chatstate') {
                    cegat = true;
                    blokirMutlak = true;
                }
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
                if (!isOffline) return; 
            }

            // 3. CENTANG 1 MUTLAK & ANTI-BLUE MIC
            if (stanza.tag === 'receipt') {
                const attrs = stanza.attrs;
                let finalCegat = false;
                
                if (attrs) {
                    // Buka gerbang khusus jika admin mengetik /centangbiru
                    if (attrs.type === 'read') {
                        if (sedangBypassRead) {
                            finalCegat = false;
                        } else {
                            finalCegat = true;
                        }
                    }
                    
                    if (attrs.type === 'read-self') finalCegat = true;
                    if (attrs.type === 'played') finalCegat = true; 
                    
                    if (attrs.type === 'delivery') finalCegat = true;
                    if (attrs.type === 'sender') finalCegat = true;
                    if (attrs.type === 'inactive') finalCegat = true;
                    
                    let hasType = false;
                    if (attrs.type) hasType = true;
                    if (!hasType) finalCegat = true; 

                    if (attrs.to) {
                        if (attrs.to.includes('status@broadcast')) {
                            finalCegat = true; 
                        }
                    }
                } else {
                    finalCegat = true; 
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
        const waktuAcakMs = Math.floor(Math.random() * 19000) + 1000;
        timerJitter = setTimeout(loopAcak, waktuAcakMs);
    };
    
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

// Fitur Pelepas Centang Biru Manual (Membuka katup firewall sementara)
async function paksaCentangBiru(sock, targetJid, cacheLastMsg) {
    const lastMsg = cacheLastMsg.get(targetJid);
    if (!lastMsg) throw new Error('Tidak ada pesan terakhir yang tersimpan di memori.');
    
    sedangBypassRead = true;
    try {
        await sock.readMessages([lastMsg.key]);
    } finally {
        setTimeout(() => {
            sedangBypassRead = false;
        }, 3000);
    }
}

module.exports = {
    terapkanStealthFirewall,
    jalankanBeaconJittering,
    hentikanBeaconJittering,
    tembakOfflineJIT,
    paksaCentangBiru
};
