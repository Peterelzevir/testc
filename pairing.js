// pairing-connection.js
// Import crypto global jika diperlukan
global.crypto = require('crypto');

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const chalk = require('chalk');
const readline = require('readline');

console.log(chalk.green('================================='));
console.log(chalk.green('WhatsApp Pairing Mode'));
console.log(chalk.green('=================================\n'));

// Ambil nomor telepon dari argumen atau minta input
let phoneNumber = process.argv[2];

// Fungsi untuk meminta input nomor telepon
async function promptPhoneNumber() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(chalk.yellow('Masukkan nomor telepon (format: 628xxxxxxxx): '), (number) => {
      rl.close();
      resolve(number);
    });
  });
}

async function startPairing() {
  // Jika nomor telepon tidak disediakan melalui argumen, minta dari input
  if (!phoneNumber) {
    console.log(chalk.yellow('Nomor telepon tidak ditemukan dalam argumen.'));
    phoneNumber = await promptPhoneNumber();
  }

  // Pastikan format nomor telepon benar
  if (!phoneNumber.startsWith('62')) {
    console.log(chalk.yellow('Menggunakan format internasional (62)...'));
    if (phoneNumber.startsWith('0')) {
      phoneNumber = '62' + phoneNumber.substring(1);
    } else if (!phoneNumber.startsWith('62')) {
      phoneNumber = '62' + phoneNumber;
    }
  }

  console.log(chalk.blue('Menggunakan nomor telepon:'), chalk.green(phoneNumber));
  console.log(chalk.yellow('Memulai proses pairing...\n'));

  try {
    // Gunakan folder terpisah untuk autentikasi pairing
    const { state, saveCreds } = await useMultiFileAuthState('pairing-auth');

    // Buat instance WhatsApp connection khusus untuk pairing
    const sock = makeWASocket({
      printQRInTerminal: false,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Chrome (Linux)', '', ''],
      version: [2, 2326, 5],
      pairingCode: true,
      mobile: false,
      phoneNumber: phoneNumber
    });

    // Listen for connection updates dan tampilkan kode pairing
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      // Tampilkan kode pairing
      if (update.pairingCode) {
        console.log(chalk.blue('\n== KODE PAIRING =='));
        console.log(chalk.green(update.pairingCode.split('').join(' ')));
        console.log(chalk.blue('=================\n'));
        console.log(chalk.yellow('Masukkan kode di atas di WhatsApp Anda > Perangkat Tertaut > Tautkan Perangkat\n'));
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect.error instanceof Boom && 
                               lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut);
        
        console.log(chalk.red('\n❌ Koneksi terputus karena:'), lastDisconnect.error);
        
        if (shouldReconnect) {
          console.log(chalk.yellow('🔄 Mencoba menghubungkan kembali...'));
          startPairing();
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
        } catch (error) {
          console.log(chalk.red('Tidak dapat mengambil informasi perangkat:', error));
        }
        
        console.log(chalk.green('\nProses pairing berhasil! Tekan Ctrl+C untuk keluar.'));
        console.log(chalk.blue('File otentikasi disimpan di folder "pairing-auth"'));
        console.log(chalk.yellow('Anda dapat menggunakan file ini untuk bot utama Anda.'));
      }
    });

    // Listen for credential updates
    sock.ev.on('creds.update', saveCreds);

  } catch (error) {
    console.error(chalk.red('Error:'), error);
  }
}

// Mulai proses pairing
startPairing();
