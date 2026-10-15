// =========================================================================
// STEALTH ENGINE (Modul Privasi Mutlak)
// Menangani manipulasi XML Stanza tingkat rendah untuk mode hantu
// =========================================================================

function terapkanStealthFirewall(sock, dbConfig) {
    const sendNodeAsli = sock.sendNode.bind(sock);
    
    sock.sendNode = async (stanza) => {
        let cegat = false;
        
        if (dbConfig.stealthMode) {
            if (stanza) {
                // Tangkap indikator online dan mengetik
                if (stanza.tag === 'presence') cegat = true;
                if (stanza.tag === 'chatstate') cegat = true;
                // Tangkap semua jenis tanda baca / tanda terima
                if (stanza.tag === 'receipt') cegat = true;
            }
        }
        
        if (cegat) {
            if (stanza.tag === 'receipt') {
                const attrs = stanza.attrs;
                let finalCegat = false;
                
                if (attrs) {
                    if (attrs.type === 'read') finalCegat = true;
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
                }
                if (finalCegat) return; 
            } else {
                // Bunuh paket 'presence' dan 'chatstate' tanpa kompromi
                return;
            }
        }
        return await sendNodeAsli(stanza);
    };
}

// Fitur Tembakan Paksa Offline (Just-In-Time)
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
    tembakOfflineJIT,
    paksaCentangBiru
};
