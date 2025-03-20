// test-connection.js
// Kode ini hanya untuk menguji koneksi ke WhatsApp

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
//
global.crypto = require('crypto');

console.log(chalk.green('================================='));
console.log(chalk.green('WhatsApp Connection Test'));
console.log(chalk.green('=================================\n'));

async function connectToWhatsApp() {
  // Deteksi apakah akan menggunakan mode pairing
  const usePairingCode = process.argv.includes('--pairing');
  const phoneNumber = usePairingCode ? process.argv[process.argv.indexOf('--pairing') + 1] : undefined;
  
  // Log metode koneksi yang digunakan
  if (usePairingCode && phoneNumber) {
    console.log(chalk.blue('Mode koneksi:'), chalk.yellow('Pairing Code'));
    console.log(chalk.blue('Nomor telepon:'), chalk.yellow(phoneNumber));
  } else {
    console.log(chalk.blue('Mode koneksi:'), chalk.yellow('QR Code'));
  }

  // Menggunakan auth state dari folder temp-auth
  const { state, saveCreds } = await useMultiFileAuthState('temp-auth');
  
  // Buat instance WhatsApp connection
  const sock = makeWASocket({
    printQRInTerminal: !usePairingCode, // Jangan print QR jika mode pairing
    auth: state,
    logger: pino({ level: 'silent' }),
    mobile: false, // false = versi web WhatsApp
    ...(usePairingCode && phoneNumber ? {
      pairingCode: true,
      phoneNumber: phoneNumber,
    } : {})
  });
  
  // Listen for connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    // Tampilkan kode pairing jika menggunakan mode pairing
    if (usePairingCode && update.pairingCode) {
      console.log(chalk.blue('\nKode Pairing:'), chalk.green(update.pairingCode));
      console.log(chalk.yellow('\nMasukkan kode di atas di WhatsApp Anda > Linked Devices > Link a Device\n'));
    }
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom && 
                             lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut);
      
      console.log(chalk.red('\n❌ Koneksi terputus karena:'), lastDisconnect.error);
      
      if (shouldReconnect) {
        console.log(chalk.yellow('🔄 Mencoba menghubungkan kembali...'));
        connectToWhatsApp();
      } else {
        console.log(chalk.red('💤 Koneksi terputus. Silakan jalankan program lagi.'));
      }
    }
    
    if (connection === 'open') {
      console.log(chalk.green('\n✅ Berhasil terhubung ke WhatsApp!'));
      
      // Tampilkan informasi perangkat yang terhubung
      try {
        const info = sock.user;
        console.log(chalk.blue('\nInformasi Akun:'));
        console.log(chalk.blue('Nama:'), chalk.yellow(info.name));
        console.log(chalk.blue('Nomor:'), chalk.yellow(info.id.split(':')[0]));
        console.log(chalk.blue('Platform:'), chalk.yellow(info.platform || 'Unknown'));
      } catch (error) {
        console.log(chalk.red('Tidak dapat mengambil informasi perangkat:', error));
      }
      
      console.log(chalk.green('\nTest koneksi berhasil! Tekan Ctrl+C untuk keluar.'));
      
      // Kirim pesan ke diri sendiri sebagai konfirmasi
      try {
        const myJid = sock.user.id.replace(/:.*@/, '@');
        await sock.sendMessage(myJid, { text: '✅ Test koneksi berhasil! Bot siap digunakan.' });
        console.log(chalk.green('Pesan konfirmasi dikirim ke nomor Anda.'));
      } catch (error) {
        console.log(chalk.red('Tidak dapat mengirim pesan konfirmasi:', error));
      }
    }
  });
  
  // Listen for credential updates
  sock.ev.on('creds.update', saveCreds);
  
  // Contoh menangani pesan masuk (opsional, hanya untuk testing)
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (messages && messages[0]) {
      const message = messages[0];
      
      // Hanya respon ke pesan dari diri sendiri untuk testing
      if (message.key.fromMe === false) {
        console.log(chalk.blue('\nMenerima pesan dari:'), chalk.yellow(message.key.remoteJid));
        const messageText = message.message?.conversation || 
                         message.message?.extendedTextMessage?.text || 
                         'Media Message';
        console.log(chalk.blue('Isi pesan:'), chalk.yellow(messageText));
        
        // Optional: Balas pesan test dengan Echo
        if (messageText.toLowerCase().includes('test')) {
          await sock.sendMessage(message.key.remoteJid, { text: 'WhatsApp Bot Test Connection: OK' }, { quoted: message });
          console.log(chalk.green('Membalas pesan test...'));
        }
      }
    }
  });
}

// Jalankan fungsi koneksi
connectToWhatsApp().catch(err => console.log('Error di fungsi utama:', err));

console.log(chalk.yellow('\nMenunggu koneksi...'));
console.log(chalk.yellow('Untuk menggunakan pairing code: node test-connection.js --pairing 628xxxxxxxx'));
