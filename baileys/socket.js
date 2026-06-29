/*
 * socket.js — connection lifecycle for WhatsApp multi-device via Baileys.
 *
 * runSocket() connects (printing a QR on first link), persists auth in ./auth,
 * auto-reconnects on drops, and hands new messages to onMessage. The current
 * live socket is reachable through the getSock() it returns, so callers always
 * send through the active connection even after a reconnect.
 */
const path = require('path');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const makeWASocket = require('baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('baileys');

const AUTH_DIR = path.join(__dirname, 'auth');

async function runSocket({ onOpen, onMessage } = {}) {
  let sock = null;

  const connect = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'silent' }),
      browser: Browsers.macOS('WA-Forward'),
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        console.log('\nScan with WhatsApp → Settings → Linked devices → Link a device:\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        console.log('✓ Connected to WhatsApp.');
        if (onOpen) onOpen(sock);
      }
      if (connection === 'close') {
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode
          : undefined;
        if (code === DisconnectReason.loggedOut) {
          console.error('Logged out. Delete the ./auth folder and re-link.');
          process.exit(1);
        }
        console.log(`Connection closed (code ${code}). Reconnecting in 2s…`);
        setTimeout(connect, 2000);
      }
    });

    if (onMessage) {
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        // Pass every message through with its type; index.js logs all arrivals and
        // forwards only live ('notify') ones.
        for (const msg of messages) onMessage(msg, type);
      });
    }
  };

  await connect();
  return () => sock; // getter for the current live socket
}

module.exports = { runSocket, AUTH_DIR };
