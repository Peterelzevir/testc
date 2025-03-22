const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const crypto = require('crypto');

// Your Telegram Bot Token
const bot = new Telegraf('7789525025:AAG1_g8sVqYAuFObspbg5utzdKIUjnG8cCc');

// URL storage for callback data (to avoid Telegram's 64-byte callback data limit)
const urlStorage = new Map();

// Generate a short unique ID for URL storage
function generateUrlId(url) {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return hash.substring(0, 12); // 12 chars should be unique enough
}

// Store URL and return short ID
function storeUrl(url) {
    const id = generateUrlId(url);
    urlStorage.set(id, url);
    return id;
}

// Retrieve URL from storage
function getUrl(id) {
    return urlStorage.get(id);
}

// Clean up old URLs periodically (every hour)
setInterval(() => {
    // Basic cleanup to prevent memory leaks
    if (urlStorage.size > 1000) {
        console.log(`Cleaning URL storage. Size before: ${urlStorage.size}`);
        const keys = Array.from(urlStorage.keys()).slice(0, 500);
        keys.forEach(key => urlStorage.delete(key));
        console.log(`Cleaned URL storage. Size after: ${urlStorage.size}`);
    }
}, 3600000);

// Temporary directory for downloads
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir);
}

// Utility to download files with redirect support
async function downloadFile(url, filePath) {
    // Use axios instead of http/https for better redirect handling
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            maxRedirects: 5,  // Allow up to 5 redirects
            timeout: 300000,   // 30 second timeout
            validateStatus: status => status >= 200 && status < 400 // Accept 2xx and 3xx status codes
        });
        
        const writer = fs.createWriteStream(filePath);
        
        return new Promise((resolve, reject) => {
            response.data.pipe(writer);
            
            let error = null;
            writer.on('error', err => {
                error = err;
                writer.close();
                reject(err);
            });
            
            writer.on('close', () => {
                if (!error) {
                    resolve(filePath);
                }
                // No need to reject here, already done in the error handler
            });
        });
    } catch (error) {
        console.error('Download error details:', error.message);
        throw new Error(`Failed to download: ${error.message}`);
    }
}

// Helper functions for text formatting
function truncateText(text, maxLength) {
    if (!text) return 'N/A';
    return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
}

function formatNumber(num) {
    if (num === undefined || num === null) return 'N/A';
    return num.toLocaleString();
}

// Setup user-specific session management to handle concurrent users
const userSessions = new Map();

// Session middleware that isolates user sessions
bot.use((ctx, next) => {
    // Create user-specific session using userId as the key
    const userId = ctx.from?.id;
    if (!userId) return next();
    
    if (!userSessions.has(userId)) {
        userSessions.set(userId, {});
    }
    
    ctx.session = userSessions.get(userId);
    
    // Add user state tracking to prevent operation conflicts
    if (!ctx.session.operations) {
        ctx.session.operations = {
            isDownloading: false,
            lastOperation: null,
            lastOperationTime: null
        };
    }
    
    return next();
});

// Safe reply function that won't throw if there's an issue
async function safeReply(ctx, text, extra = {}) {
    try {
        if (text.includes('*') || text.includes('_')) {
            return await ctx.replyWithMarkdown(text, extra);
        } else {
            return await ctx.reply(text, extra);
        }
    } catch (error) {
        console.error('Error in safeReply:', error);
        try {
            // Try plain text as last resort
            return await ctx.reply(text.replace(/\*/g, '').replace(/_/g, ''), extra);
        } catch (e) {
            console.error('Failed even with plain text:', e);
        }
    }
}

// Utility function to send a new message or edit the last bot message
async function sendOrEditMessage(ctx, text, extra = {}) {
    try {
        if (ctx.session && ctx.session.lastBotMsgId) {
            try {
                return await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    ctx.session.lastBotMsgId,
                    null,
                    text,
                    { 
                        parse_mode: 'Markdown',
                        ...extra 
                    }
                );
            } catch (error) {
                console.log('Error editing message, sending new one instead:', error.message);
                const msg = await ctx.replyWithMarkdown(text, extra);
                if (msg) ctx.session.lastBotMsgId = msg.message_id;
                return msg;
            }
        } else {
            const msg = await ctx.replyWithMarkdown(text, extra);
            if (msg) ctx.session.lastBotMsgId = msg.message_id;
            return msg;
        }
    } catch (error) {
        console.error('Error in sendOrEditMessage:', error);
        return await safeReply(ctx, text, extra);
    }
}

// Start command handler with stylish welcome message
bot.start(async (ctx) => {
    try {
        const message = `
🌟 *Selamat Datang di DL Master Bot* 🌟

Gw bisa bantu lo download video dan audio dari:
🔥 *TikTok* - video & lagu
🎬 *YouTube* - video berbagai kualitas

*Cara Pakai:*
1️⃣ Klik tombol di bawah untuk pilih platform
2️⃣ Kirim link yang mau lo download
3️⃣ Pilih mau download yang mana
4️⃣ Tunggu bentar ya, proses dulu ✨

_Dibuat dengan ❤️ biar lo gampang download_
`;

        await ctx.replyWithMarkdown(message, 
            Markup.inlineKeyboard([
                [Markup.button.callback('📱 TikTok Downloader', 'tiktok_down')],
                [Markup.button.callback('📺 YouTube Downloader', 'youtube_down')]
            ])
        );
    } catch (error) {
        console.error('Error in start command:', error);
        await safeReply(ctx, '⚠️ Ups, ada masalah nih. Coba lagi ya.');
    }
});

// Help command
bot.help(async (ctx) => {
    try {
        await ctx.replyWithMarkdown(`
*📚 Bantuan & Perintah Bot 📚*

/start - Jalankan bot & lihat menu utama
/help - Tampilkan bantuan ini
/cancel - Batalkan operasi yang sedang berjalan

*Cara Download:*
• Untuk *TikTok*: Kirim link video TikTok
• Untuk *YouTube*: Kirim link YouTube, trus pilih kualitasnya

*Ada Masalah?*
• Pastiin link valid dan videonya publik
• Bot lagi proses satu request? Sabar ya
• Video jangan kegedean (max 50MB)

_Butuh bantuan lain? Kontak @yourusername_
`);
    } catch (error) {
        console.error('Error in help command:', error);
        await safeReply(ctx, '⚠️ Ups, ada masalah nih. Coba lagi ya.');
    }
});

// TikTok download
bot.action('tiktok_down', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete message:', e.message);
        }
        
        // Check if user already has an operation in progress
        if (ctx.session.operations && ctx.session.operations.isDownloading) {
            await ctx.replyWithMarkdown(`
*⚠️ Lu masih ada proses yang belum selesai nih!*

Tunggu sampai selesai ya, atau klik /cancel buat batalin.
            `);
            return;
        }
        
        const message = await ctx.replyWithMarkdown(`
*🔥 Mode TikTok Downloader Aktif 🔥*

👉 Kirim link TikTok yang mau lu download
_Contoh: https://www.tiktok.com/@username/video/1234567890_

🔍 Nanti gw extract video & audio buat lu!
        `);
        
        ctx.session = {
            mode: 'tiktok',
            lastBotMsgId: message.message_id,
            operations: {
                isDownloading: false,
                lastOperation: 'tiktok_mode',
                lastOperationTime: Date.now()
            }
        };
    } catch (error) {
        console.error('Error in tiktok_down action:', error);
        await safeReply(ctx, 'Waduh, error nih. Coba /start lagi ya.');
    }
});

// YouTube download
bot.action('youtube_down', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete message:', e.message);
        }
        
        // Check if user already has an operation in progress
        if (ctx.session.operations && ctx.session.operations.isDownloading) {
            await ctx.replyWithMarkdown(`
*⚠️ Lu masih ada proses yang belum selesai nih!*

Tunggu sampai selesai ya, atau klik /cancel buat batalin.
            `);
            return;
        }
        
        const message = await ctx.replyWithMarkdown(`
*📺 Mode YouTube Downloader Aktif 📺*

👉 Kirim link YouTube yang mau lu download
_Contoh: https://www.youtube.com/watch?v=dQw4w9WgXcQ_

🎬 Nanti lu bisa pilih kualitas videonya!
        `);
        
        ctx.session = {
            mode: 'youtube',
            lastBotMsgId: message.message_id,
            operations: {
                isDownloading: false,
                lastOperation: 'youtube_mode',
                lastOperationTime: Date.now()
            }
        };
    } catch (error) {
        console.error('Error in youtube_down action:', error);
        await safeReply(ctx, 'Waduh, error nih. Coba /start lagi ya.');
    }
});

// Cancel command
bot.command('cancel', async (ctx) => {
    try {
        ctx.session = {};
        await ctx.replyWithMarkdown('*🚫 Operasi dibatalin!*\nPakai /start buat mulai lagi ya.');
    } catch (error) {
        console.error('Error in cancel command:', error);
        await safeReply(ctx, '⚠️ Ups, ada masalah nih. Coba /start lagi aja ya.');
    }
});

// Handle URLs and text messages
bot.on('text', async (ctx) => {
    try {
        const text = ctx.message.text;
        
        // Check if user already has an operation in progress
        if (ctx.session.operations && ctx.session.operations.isDownloading) {
            await ctx.replyWithMarkdown(`
*⚠️ Lu masih ada proses yang belum selesai nih!*

Tunggu sampai selesai ya, atau klik /cancel buat batalin.
            `);
            return;
        }
        
        // If no active mode, check if it's a URL and try to detect platform
        if (!ctx.session || !ctx.session.mode) {
            if (text.includes('tiktok.com')) {
                ctx.session = { 
                    mode: 'tiktok',
                    operations: {
                        isDownloading: false,
                        lastOperation: 'auto_tiktok',
                        lastOperationTime: Date.now()
                    }
                };
                await handleTikTokUrl(ctx, text);
            } else if (text.includes('youtube.com') || text.includes('youtu.be')) {
                ctx.session = { 
                    mode: 'youtube',
                    operations: {
                        isDownloading: false,
                        lastOperation: 'auto_youtube',
                        lastOperationTime: Date.now()
                    }
                };
                await handleYouTubeUrl(ctx, text);
            } else {
                await ctx.replyWithMarkdown(`
*🤔 Gw ga ngerti lu mau download apa*

Coba pakai /start dulu ya, biar jelas.
                `);
            }
            return;
        }
        
        // Handle based on current mode
        if (ctx.session.mode === 'tiktok') {
            if (text.includes('tiktok.com')) {
                await handleTikTokUrl(ctx, text);
            } else {
                await ctx.replyWithMarkdown(`
*⚠️ Link TikTok ga valid! ⚠️*

Kirim link TikTok yang bener ya, yang kayak gini:
_https://www.tiktok.com/@username/video/1234567890_

Atau ketik /cancel kalau mau batalin.
                `);
            }
        } else if (ctx.session.mode === 'youtube') {
            if (ctx.session.waitingForQuality) {
                // Ignore, we're waiting for quality selection via buttons
                return;
            }
            
            if (text.includes('youtube.com') || text.includes('youtu.be')) {
                await handleYouTubeUrl(ctx, text);
            } else {
                await ctx.replyWithMarkdown(`
*⚠️ Link YouTube ga valid! ⚠️*

Kirim link YouTube yang bener ya, yang kayak gini:
_https://www.youtube.com/watch?v=dQw4w9WgXcQ_
_https://youtu.be/dQw4w9WgXcQ_

Atau ketik /cancel kalau mau batalin.
                `);
            }
        }
    } catch (error) {
        console.error('Error handling text message:', error);
        await safeReply(ctx, '⚠️ Waduh, ada error nih. Coba /start lagi ya.');
    }
});

// Handle TikTok URL
async function handleTikTokUrl(ctx, url) {
    try {
        // Set downloading flag to prevent multiple operations
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = true;
            ctx.session.operations.lastOperation = 'tiktok_download';
            ctx.session.operations.lastOperationTime = Date.now();
        }
        
        // Try to delete user message to keep chat clean
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete message:', e.message);
        }
        
        // Edit previous bot message or send new one with processing info
        const processingMsg = await sendOrEditMessage(ctx, `
*🔄 Lagi Proses Link TikTok...*

🔍 Lagi analisis: \`${url}\`
⏳ Tunggu bentar ya, lagi ambil detail video...
        `);
        
        // Store message ID for future edits
        ctx.session.lastBotMsgId = processingMsg.message_id;
        
        // Try alternative APIs if one fails
        let result = null;
        let apiError = null;
        
        // First API attempt
        try {
            // Call TikTok API
            const apiUrl = `https://fastrestapis.fasturl.cloud/downup/ttdown?url=${encodeURIComponent(url)}`;
            const response = await axios.get(apiUrl, { timeout: 15000 });
            
            if (response.data.status === 200 && response.data.result) {
                result = response.data.result;
            } else {
                apiError = 'API pertama error: ' + (response.data.content || 'Error ga diketahui');
            }
        } catch (err) {
            apiError = `API pertama error: ${err.message}`;
            console.log(apiError);
        }
        
        // Try alternative API if first one failed
        if (!result) {
            try {
                // Alternative API
                await sendOrEditMessage(ctx, `
*🔄 API pertama gagal, nyoba alternatif...*

🔍 Masih proses: \`${url}\`
⏳ Sabar ya...
                `);
                
                const apiUrl2 = `https://api.tikwm.com/service/api/videoData?url=${encodeURIComponent(url)}`;
                const response = await axios.get(apiUrl2, { timeout: 15000 });
                
                if (response.data.code === 0 && response.data.data) {
                    // Map the alternative API response to match our expected format
                    const altData = response.data.data;
                    result = {
                        title: altData.title,
                        author: altData.author.nickname,
                        duration: altData.duration,
                        playCount: altData.play_count,
                        likes: altData.likes,
                        comments: altData.comments,
                        shares: altData.shares,
                        originalSound: {
                            title: altData.music_info ? altData.music_info.title : 'Ga diketahui'
                        },
                        media: {
                            coverUrl: altData.cover,
                            videoUrl: altData.play, // Or altData.wmplay for watermarked version
                            musicUrl: altData.music
                        }
                    };
                } else {
                    throw new Error('API alternatif error: ' + JSON.stringify(response.data));
                }
            } catch (err) {
                throw new Error(`Dua-duanya gagal nih. ${apiError}. API kedua error: ${err.message}`);
            }
        }
        
        // Check if we have a result
        if (!result || !result.media) {
            throw new Error('Ga dapet data valid dari API');
        }
        
        // Send direct download buttons without requiring thumbnail first
        // Store media URLs with short IDs
        const videoUrlId = storeUrl(result.media.videoUrl);
        const audioUrlId = storeUrl(result.media.musicUrl);
        
        // Handle potentially undefined values with safe getters
        const title = result.title || 'Judul ga diketahui';
        const author = result.author || 'Creator ga diketahui';
        const duration = result.duration || 'N/A';
        const playCount = result.playCount || 0;
        const likes = result.likes || 0;
        const comments = result.comments || 0;
        const shares = result.shares || 0;
        const soundTitle = result.originalSound && result.originalSound.title 
            ? result.originalSound.title 
            : 'Ga diketahui';
        
        // Create caption with info
        const caption = `
*🎵 Video TikTok Ketemu! 🎵*

*🎬 Judul:* ${truncateText(title, 150)}
*👤 Creator:* ${author}
*⏱️ Durasi:* ${duration}s
*👁️ Views:* ${formatNumber(playCount)}
*👍 Likes:* ${formatNumber(likes)}
*💬 Komentar:* ${formatNumber(comments)}
*🔄 Shares:* ${formatNumber(shares)}

🎵 *Sound Asli:* "${truncateText(soundTitle, 100)}"

_Pilih yang mau lu download:_
        `;
        
        // Try to download thumbnail in parallel for faster response
        let thumbnailPath = null;
        try {
            thumbnailPath = path.join(tmpDir, `tiktok_${Date.now()}.jpg`);
            await downloadFile(result.media.coverUrl, thumbnailPath);
            
            // Try to delete processing message
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.lastBotMsgId);
            } catch (e) {
                console.log('Could not delete processing message:', e.message);
            }
            
            // Send thumbnail with options
            await ctx.replyWithPhoto({ source: thumbnailPath }, {
                caption: caption,
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback('📹 Download Video', `ttvideo_${videoUrlId}`),
                        Markup.button.callback('🎵 Download Audio', `ttaudio_${audioUrlId}`)
                    ]
                ])
            });
            
            // Clean up
            fs.unlinkSync(thumbnailPath);
        } catch (thumbError) {
            console.error('Error with thumbnail, sending text only:', thumbError);
            
            // Send text only if thumbnail fails
            await sendOrEditMessage(ctx, caption, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            Markup.button.callback('📹 Download Video', `ttvideo_${videoUrlId}`),
                            Markup.button.callback('🎵 Download Audio', `ttaudio_${audioUrlId}`)
                        ]
                    ]
                }
            });
        }
        
        // Reset downloading flag
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
        
    } catch (error) {
        console.error('Error handling TikTok URL:', error);
        await sendOrEditMessage(ctx, `
*❌ Error Proses Link TikTok ❌*

Sorry, gw ga bisa download video TikTok ini. Error: ${error.message}

Ini mungkin gara-gara:
• TikTok baru update sistem mereka
• Video ini private atau dilock
• Masalah jaringan

Coba lagi dengan video lain atau nanti ya.
        `);
        
        // Reset downloading flag on error
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
    }
}

// Handle YouTube URL
async function handleYouTubeUrl(ctx, url) {
    try {
        // Set downloading flag to prevent multiple operations
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = true;
            ctx.session.operations.lastOperation = 'youtube_quality_selection';
            ctx.session.operations.lastOperationTime = Date.now();
        }
        
        // Try to delete user message to keep chat clean
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete message:', e.message);
        }
        
        // Edit previous bot message or send new one with processing info
        const processingMsg = await sendOrEditMessage(ctx, `
*🔄 Lagi Proses Link YouTube...*

🔍 Lagi analisis: \`${url}\`
⏳ Tunggu bentar ya...
        `);
        
        // Store message ID for future edits
        ctx.session.lastBotMsgId = processingMsg.message_id;
        
        // Store YouTube URL in session with a short ID
        const urlId = storeUrl(url);
        ctx.session.youtubeUrlId = urlId;
        ctx.session.waitingForQuality = true;
        
        // Send quality selection buttons
        await sendOrEditMessage(ctx, `
*📺 Pilih Kualitas Video 📺*

URL Video: \`${truncateText(url, 100)}\`

Pilih kualitas yang lu mau:
_Kualitas lebih tinggi = file lebih gede_
        `, {
            reply_markup: {
                inline_keyboard: [
                    [
                        Markup.button.callback('144p', `ytq_144_${urlId}`),
                        Markup.button.callback('240p', `ytq_240_${urlId}`),
                        Markup.button.callback('360p', `ytq_360_${urlId}`)
                    ],
                    [
                        Markup.button.callback('480p', `ytq_480_${urlId}`),
                        Markup.button.callback('720p', `ytq_720_${urlId}`),
                        Markup.button.callback('1080p', `ytq_1080_${urlId}`)
                    ]
                ]
            }
        });
        
        // Reset downloading flag since we're just waiting for button press now
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
        
    } catch (error) {
        console.error('Error handling YouTube URL:', error);
        await sendOrEditMessage(ctx, `
*❌ Error Proses Link YouTube ❌*

Sorry, gw ga bisa proses link YouTube ini. Coba cek:
• Link bener ga dan videonya publik
• Video masih ada ga (ga dihapus)
• Server YouTube lagi lancar ga

Coba lagi dengan video lain atau nanti ya.
        `);
        
        // Reset downloading flag on error
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
    }
}

// YouTube quality selection handler
bot.action(/ytq_(\d+)_(.+)/, async (ctx) => {
    try {
        await ctx.answerCbQuery('Lagi proses request lu...');
        
        // Check if user already has an operation in progress
        if (ctx.session.operations && ctx.session.operations.isDownloading) {
            await ctx.replyWithMarkdown(`
*⚠️ Lu masih ada proses yang belum selesai nih!*

Tunggu sampai selesai ya, atau klik /cancel buat batalin.
            `);
            return;
        }
        
        // Set downloading flag
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = true;
            ctx.session.operations.lastOperation = 'youtube_download';
            ctx.session.operations.lastOperationTime = Date.now();
        } else {
            ctx.session.operations = {
                isDownloading: true,
                lastOperation: 'youtube_download',
                lastOperationTime: Date.now()
            };
        }
        
        const quality = ctx.match[1];
        const urlId = ctx.match[2];
        const url = getUrl(urlId);
        
        if (!url) {
            throw new Error('URL ga ditemukan di storage');
        }
        
        // Try to delete the quality selection message
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete quality selection message:', e.message);
        }
        
        // Send processing message
        const processingMsg = await ctx.replyWithMarkdown(`
*🔄 Lagi Ambil Detail Video YouTube...*

🎬 URL: \`${truncateText(url, 100)}\`
🎮 Kualitas: ${quality}p
⏳ Ini bisa makan waktu agak lama...
        `);
        
        ctx.session.lastBotMsgId = processingMsg.message_id;
        
        // Call YouTube API
        const apiUrl = `https://fastrestapis.fasturl.cloud/downup/ytmp4?url=${encodeURIComponent(url)}&quality=${quality}&server=auto`;
        const response = await axios.get(apiUrl, { timeout: 30000 });
        
        if (response.data.status !== 200) {
            throw new Error('API error: ' + (response.data.content || 'Error ga diketahui'));
        }
        
        const result = response.data.result;
        
        // Check if required properties exist
        if (!result.media) {
            throw new Error('Ga ada URL media di response API');
        }
        
        // Safely access nested properties
        const metadata = result.metadata || {};
        const author = result.author || {};
        
        // Store the download URL with a short ID
        const downloadUrlId = storeUrl(result.media);
        
        // If response was quick, wait a bit to not confuse the user
        const responseTime = Date.now() - ctx.session.operations.lastOperationTime;
        if (responseTime < 2000) {
            await new Promise(resolve => setTimeout(resolve, 2000 - responseTime));
        }
        
        // Format video information
        const caption = `
*📺 Video YouTube Ketemu! 📺*

*🎬 Judul:* ${truncateText(result.title || 'Judul ga diketahui', 150)}
*👤 Channel:* ${author.name || 'Ga diketahui'}
*⏱️ Durasi:* ${metadata.duration || 'N/A'}
*👁️ Views:* ${formatNumber(metadata.views || 0)}
*📅 Upload:* ${metadata.uploadDate || 'Ga diketahui'}
*🎮 Kualitas:* ${result.quality || quality + 'p'}

_Klik tombol di bawah buat download:_
        `;
        
        // Update existing message
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            null,
            caption,
            { 
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [Markup.button.callback('📥 Download Video', `ytdownload_${downloadUrlId}`)]
                    ]
                }
            }
        );
        
        // Reset the waiting flag
        ctx.session.waitingForQuality = false;
        
        // Reset downloading flag since we're just waiting for button press now
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
        
    } catch (error) {
        console.error('Error processing YouTube quality selection:', error);
        
        await ctx.replyWithMarkdown(`
*❌ Error Proses Video YouTube ❌*

Sorry, gw ga bisa download video ini dengan kualitas ${ctx.match ? ctx.match[1] : ''}p.

Ini mungkin gara-gara:
• Video ada batasan atau masalah copyright
• Kualitas yang lu pilih ga tersedia
• Masalah server download

Coba kualitas lain atau video lain ya.
        `);
        
        // Reset downloading flag on error
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
    }
});

// TikTok video download handler
bot.action(/ttvideo_(.+)/, async (ctx) => {
    try {
        await ctx.answerCbQuery('Lagi download video...');
        
        // Check if user already has an operation in progress
        if (ctx.session.operations && ctx.session.operations.isDownloading) {
            await ctx.replyWithMarkdown(`
*⚠️ Lu masih ada proses yang belum selesai nih!*

Tunggu sampai selesai ya, atau klik /cancel buat batalin.
            `);
            return;
        }
        
        // Set downloading flag
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = true;
            ctx.session.operations.lastOperation = 'tiktok_video_download';
            ctx.session.operations.lastOperationTime = Date.now();
        } else {
            ctx.session.operations = {
                isDownloading: true,
                lastOperation: 'tiktok_video_download',
                lastOperationTime: Date.now()
            };
        }
        
        const urlId = ctx.match[1];
        const videoUrl = getUrl(urlId);
        
        if (!videoUrl) {
            throw new Error('URL video ga ditemukan di storage');
        }
        
        // Try to delete the message with the buttons
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete message with buttons:', e.message);
        }
        
        // Send processing message
        const processingMsg = await ctx.replyWithMarkdown(`
*📥 Lagi Download Video TikTok...*

⏳ Tunggu bentar ya, lagi proses...
        `);
        
        // Set up progress tracking
        let lastUpdateTime = Date.now();
        let downloadedSize = 0;
        let totalSize = 0;
        let progressMessage = processingMsg;
        
        try {
            // First do a HEAD request to get content length
            const headResponse = await axios({
                method: 'HEAD',
                url: videoUrl,
                timeout: 10000,
                maxRedirects: 5
            }).catch(e => null); // Ignore HEAD failures
            
            if (headResponse && headResponse.headers['content-length']) {
                totalSize = parseInt(headResponse.headers['content-length']);
            }
            
            // Use axios to stream download with progress reporting
            const videoPath = path.join(tmpDir, `tiktok_${Date.now()}.mp4`);
            const writer = fs.createWriteStream(videoPath);
            
            const response = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
                timeout: 60000,
                maxRedirects: 5
            });
            
            // Update total size if we got it from the GET request
            if (response.headers['content-length']) {
                totalSize = parseInt(response.headers['content-length']);
            }
            
            // Setup progress tracking
            response.data.on('data', (chunk) => {
                downloadedSize += chunk.length;
                
                // Update progress every 1.5 seconds to avoid API rate limits
                const now = Date.now();
                if (now - lastUpdateTime > 1500 && totalSize > 0) {
                    lastUpdateTime = now;
                    const progress = Math.round((downloadedSize / totalSize) * 100);
                    
                    // Update message with progress
                    ctx.telegram.editMessageText(
                        ctx.chat.id, 
                        progressMessage.message_id,
                        null,
                        `
*📥 Lagi Download Video TikTok... ${progress}%*

⏳ Terdownload: ${(downloadedSize / 1048576).toFixed(2)} MB / ${(totalSize / 1048576).toFixed(2)} MB
                        `,
                        { parse_mode: 'Markdown' }
                    ).catch(e => {
                        // Ignore edit errors - we'll still continue the download
                    });
                }
            });
            
            // Complete the download
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.pipe(writer);
            });
            
            // Update to 100% when completed
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMessage.message_id,
                null,
                `
*📥 Download Selesai! 100%*

⏳ Ukuran Total: ${(totalSize / 1048576).toFixed(2)} MB
📤 Lagi upload ke Telegram...
                `,
                { parse_mode: 'Markdown' }
            ).catch(e => {/* Ignore errors */});
            
            // Send the video
            await ctx.replyWithVideo(
                { source: videoPath },
                { 
                    caption: `
*🎬 Video TikTok Berhasil Didownload! 🎬*

_Selamat nonton! Pakai /start buat download lagi._
                    `,
                    parse_mode: 'Markdown'
                }
            );
            
            // Delete progress message after successful upload
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, progressMessage.message_id);
            } catch (e) {
                console.log('Could not delete progress message:', e.message);
            }
            
            // Clean up
            fs.unlinkSync(videoPath);
            
        } catch (downloadError) {
            console.error('Download error:', downloadError);
            
            // Try direct upload without download if streaming failed
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMessage.message_id,
                null,
                `
*⚠️ Error Download - Nyoba Cara Lain...*

Tunggu bentar, lagi nyoba cara alternatif...
                `,
                { parse_mode: 'Markdown' }
            ).catch(e => {/* Ignore errors */});
            
            // Try to send directly via URL
            try {
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    responseType: 'arraybuffer',
                    timeout: 60000,
                    maxRedirects: 5
                });
                
                const buffer = Buffer.from(response.data);
                const videoPath = path.join(tmpDir, `tiktok_${Date.now()}.mp4`);
                fs.writeFileSync(videoPath, buffer);
                
                // Send the video
                await ctx.replyWithVideo(
                    { source: videoPath },
                    { 
                        caption: `
*🎬 Video TikTok Berhasil Didownload! 🎬*

_Selamat nonton! Pakai /start buat download lagi._
                        `,
                        parse_mode: 'Markdown'
                    }
                );
                
                // Delete progress message after successful upload
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, progressMessage.message_id);
                } catch (e) {
                    console.log('Could not delete progress message:', e.message);
                }
                
                // Clean up
                fs.unlinkSync(videoPath);
            } catch (secondError) {
                throw new Error(`Cara pertama: ${downloadError.message}. Cara kedua: ${secondError.message}`);
            }
        }
        
        // Reset downloading flag
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
        
    } catch (error) {
        console.error('Error downloading TikTok video:', error);
        await ctx.replyWithMarkdown(`
*❌ Error Download Video ❌*

Sorry, gw ga bisa download video ini. Error: ${error.message}

Ini mungkin gara-gara:
• TikTok baru update keamanan mereka
• Video udah ga ada
• Masalah jaringan atau server

Coba lagi nanti atau dengan video lain ya.
        `);
        
        // Reset downloading flag on error
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
    }
});

// TikTok audio download handler
bot.action(/ttaudio_(.+)/, async (ctx) => {
    try {
        await ctx.answerCbQuery('Downloading audio...');
        
        const urlId = ctx.match[1];
        const audioUrl = getUrl(urlId);
        
        if (!audioUrl) {
            throw new Error('Audio URL not found in storage');
        }
        
        // Try to delete the message with the buttons
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete message with buttons:', e.message);
        }
        
        // Send processing message
        const processingMsg = await ctx.replyWithMarkdown(`
*📥 Downloading TikTok Audio...*

⏳ Please wait, processing your download...
        `);
        
        // Download the audio
        const audioPath = path.join(tmpDir, `tiktok_${Date.now()}.mp3`);
        await downloadFile(audioUrl, audioPath);
        
        // Try to delete processing message
        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
        } catch (e) {
            console.log('Could not delete processing message:', e.message);
        }
        
        // Send the audio
        await ctx.replyWithAudio(
            { source: audioPath },
            { 
                caption: `
*🎵 TikTok Audio Downloaded! 🎵*

_Enjoy your audio track! Use /start to download more._
                `,
                parse_mode: 'Markdown'
            }
        );
        
        // Clean up
        fs.unlinkSync(audioPath);
        
    } catch (error) {
        console.error('Error downloading TikTok audio:', error);
        await ctx.replyWithMarkdown(`
*❌ Error Downloading Audio ❌*

Sorry, I couldn't download this audio. This could be due to:
• The audio is no longer available
• Network or server issues
• File size limitations

Please try again later or with another TikTok.
        `);
    }
});

// YouTube video download handler
bot.action(/ytdownload_(.+)/, async (ctx) => {
    try {
        await ctx.answerCbQuery('Lagi download video YouTube...');
        
        // Check if user already has an operation in progress
        if (ctx.session.operations && ctx.session.operations.isDownloading) {
            await ctx.replyWithMarkdown(`
*⚠️ Lu masih ada proses yang belum selesai nih!*

Tunggu sampai selesai ya, atau klik /cancel buat batalin.
            `);
            return;
        }
        
        // Set downloading flag
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = true;
            ctx.session.operations.lastOperation = 'youtube_video_download';
            ctx.session.operations.lastOperationTime = Date.now();
        } else {
            ctx.session.operations = {
                isDownloading: true,
                lastOperation: 'youtube_video_download',
                lastOperationTime: Date.now()
            };
        }
        
        const urlId = ctx.match[1];
        const videoUrl = getUrl(urlId);
        
        if (!videoUrl) {
            throw new Error('URL video ga ditemukan di storage');
        }
        
        // Try to delete the message with the button
        try {
            await ctx.deleteMessage();
        } catch (e) {
            console.log('Could not delete message with button:', e.message);
        }
        
        // Send processing message
        const processingMsg = await ctx.replyWithMarkdown(`
*📥 Lagi Download Video YouTube...*

⏳ Sabar ya, lagi proses download...
⚠️ Video gede butuh waktu lebih lama
        `);
        
        // Set up progress tracking
        let lastUpdateTime = Date.now();
        let downloadedSize = 0;
        let totalSize = 0;
        let progressMessage = processingMsg;
        let chunkDownloadStartTime = Date.now();
        let downloadRate = 0; // bytes per second
        
        try {
            // First do a HEAD request to get content length
            const headResponse = await axios({
                method: 'HEAD',
                url: videoUrl,
                timeout: 10000,
                maxRedirects: 5
            }).catch(e => null); // Ignore HEAD failures
            
            if (headResponse && headResponse.headers['content-length']) {
                totalSize = parseInt(headResponse.headers['content-length']);
            }
            
            // Use axios to stream download with progress reporting
            const videoPath = path.join(tmpDir, `youtube_${Date.now()}.mp4`);
            const writer = fs.createWriteStream(videoPath);
            
            const response = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
                timeout: 120000, // Longer timeout for YouTube
                maxRedirects: 5
            });
            
            // Update total size if we got it from the GET request
            if (response.headers['content-length']) {
                totalSize = parseInt(response.headers['content-length']);
            }
            
            // Setup progress tracking
            response.data.on('data', (chunk) => {
                downloadedSize += chunk.length;
                
                // Calculate download rate
                const now = Date.now();
                const elapsed = (now - chunkDownloadStartTime) / 1000; // seconds
                if (elapsed > 0) {
                    // Smooth the rate calculation with exponential moving average
                    const instantRate = chunk.length / elapsed;
                    downloadRate = downloadRate === 0 
                        ? instantRate 
                        : 0.7 * downloadRate + 0.3 * instantRate;
                }
                chunkDownloadStartTime = now;
                
                // Update progress every 2 seconds to avoid API rate limits
                if (now - lastUpdateTime > 2000 && totalSize > 0) {
                    lastUpdateTime = now;
                    const progress = Math.round((downloadedSize / totalSize) * 100);
                    
                    // Estimate remaining time
                    let remainingText = '';
                    if (downloadRate > 0) {
                        const remainingBytes = totalSize - downloadedSize;
                        const remainingSeconds = remainingBytes / downloadRate;
                        
                        if (remainingSeconds < 60) {
                            remainingText = `≈ ${Math.round(remainingSeconds)}d lagi`;
                        } else {
                            remainingText = `≈ ${Math.round(remainingSeconds/60)}m ${Math.round(remainingSeconds%60)}d lagi`;
                        }
                    }
                    
                    // Update message with progress
                    ctx.telegram.editMessageText(
                        ctx.chat.id, 
                        progressMessage.message_id,
                        null,
                        `
*📥 Lagi Download Video YouTube... ${progress}%*

⏳ Terdownload: ${(downloadedSize / 1048576).toFixed(2)} MB / ${(totalSize / 1048576).toFixed(2)} MB
🚀 Kecepatan: ${(downloadRate / 1048576).toFixed(2)} MB/s
⌛ ${remainingText}
                        `,
                        { parse_mode: 'Markdown' }
                    ).catch(e => {
                        // Ignore edit errors - we'll still continue the download
                    });
                }
            });
            
            // Complete the download
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                response.data.pipe(writer);
            });
            
            // Update to 100% when completed
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMessage.message_id,
                null,
                `
*📥 Download Selesai! 100%*

⏳ Ukuran Total: ${(totalSize / 1048576).toFixed(2)} MB
📤 Lagi upload ke Telegram...
                `,
                { parse_mode: 'Markdown' }
            ).catch(e => {/* Ignore errors */});
            
            // Check file size - Telegram has a 50MB limit
            const stats = fs.statSync(videoPath);
            if (stats.size > 50 * 1024 * 1024) {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    progressMessage.message_id,
                    null,
                    `
*⚠️ Video Kegedean untuk Telegram*

Videonya ${(stats.size / 1048576).toFixed(2)} MB, tapi Telegram cuma boleh upload maksimal 50 MB.

Coba video yang lebih pendek atau pilih kualitas yang lebih rendah ya.
                    `,
                    { parse_mode: 'Markdown' }
                );
                
                // Clean up
                fs.unlinkSync(videoPath);
                
                // Reset downloading flag
                if (ctx.session.operations) {
                    ctx.session.operations.isDownloading = false;
                }
                return;
            }
            
            // Send the video with upload progress updates
            const uploadStartTime = Date.now();
            let lastUploadUpdateTime = uploadStartTime;
            
            // Set an interval to update the upload progress message
            const uploadIntervalId = setInterval(async () => {
                const uploadElapsed = (Date.now() - uploadStartTime) / 1000; // seconds
                
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    progressMessage.message_id,
                    null,
                    `
*📤 Lagi Upload ke Telegram...*

⏳ Ukuran Total: ${(stats.size / 1048576).toFixed(2)} MB
⌛ Udah upload ${Math.round(uploadElapsed)}d
                    `,
                    { parse_mode: 'Markdown' }
                ).catch(e => {/* Ignore errors */});
            }, 3000);
            
            // Send the video
            await ctx.replyWithVideo(
                { source: videoPath },
                { 
                    caption: `
*📺 Video YouTube Berhasil Didownload! 📺*

_Selamat nonton! Pakai /start buat download lagi._
                    `,
                    parse_mode: 'Markdown'
                }
            );
            
            // Clear the interval and delete progress message
            clearInterval(uploadIntervalId);
            
            try {
                await ctx.telegram.deleteMessage(ctx.chat.id, progressMessage.message_id);
            } catch (e) {
                console.log('Could not delete progress message:', e.message);
            }
            
            // Clean up
            fs.unlinkSync(videoPath);
            
        } catch (downloadError) {
            console.error('Download error:', downloadError);
            
            // Try chunked download if standard download failed
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMessage.message_id,
                null,
                `
*⚠️ Download Standar Gagal - Nyoba Cara Lain...*

Tunggu bentar ya, lagi coba cara alternatif...
                `,
                { parse_mode: 'Markdown' }
            ).catch(e => {/* Ignore errors */});
            
            try {
                // Try alternative download method with shorter timeout and full buffer
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    responseType: 'arraybuffer',
                    timeout: 90000,
                    maxRedirects: 5
                });
                
                const buffer = Buffer.from(response.data);
                const videoPath = path.join(tmpDir, `youtube_${Date.now()}.mp4`);
                fs.writeFileSync(videoPath, buffer);
                
                // Check file size
                const stats = fs.statSync(videoPath);
                if (stats.size > 50 * 1024 * 1024) {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMessage.message_id,
                        null,
                        `
*⚠️ Video Kegedean untuk Telegram*

Videonya ${(stats.size / 1048576).toFixed(2)} MB, tapi Telegram cuma boleh upload maksimal 50 MB.

Coba video yang lebih pendek atau pilih kualitas yang lebih rendah ya.
                        `,
                        { parse_mode: 'Markdown' }
                    );
                    
                    // Clean up
                    fs.unlinkSync(videoPath);
                    
                    // Reset downloading flag
                    if (ctx.session.operations) {
                        ctx.session.operations.isDownloading = false;
                    }
                    return;
                }
                
                // Send the video
                await ctx.replyWithVideo(
                    { source: videoPath },
                    { 
                        caption: `
*📺 Video YouTube Berhasil Didownload! 📺*

_Selamat nonton! Pakai /start buat download lagi._
                        `,
                        parse_mode: 'Markdown'
                    }
                );
                
                // Delete progress message
                try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, progressMessage.message_id);
                } catch (e) {
                    console.log('Could not delete progress message:', e.message);
                }
                
                // Clean up
                fs.unlinkSync(videoPath);
                
            } catch (secondError) {
                throw new Error(`Cara pertama: ${downloadError.message}. Cara kedua: ${secondError.message}`);
            }
        }
        
        // Reset downloading flag
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
        
    } catch (error) {
        console.error('Error downloading YouTube video:', error);
        await ctx.replyWithMarkdown(`
*❌ Error Download Video YouTube ❌*

Sorry, gw ga bisa download video ini. Error: ${error.message}

Ini mungkin gara-gara:
• Video kegedean buat Telegram (max 50MB)
• YouTube ngeblok video ini
• Link download udah expired

Coba video yang lebih pendek atau kualitas lebih rendah ya.
        `);
        
        // Reset downloading flag on error
        if (ctx.session.operations) {
            ctx.session.operations.isDownloading = false;
        }
    }
});

// Error handler with improved recovery
bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    
    try {
        ctx.reply('An error occurred. Please use /start to restart.');
    } catch (replyError) {
        console.error('Could not send error message:', replyError);
    }
});

// Start the bot
bot.launch().then(() => {
    console.log('Bot started successfully!');
    
    // Setup auto cleanup of temp directory
    setInterval(() => {
        try {
            const files = fs.readdirSync(tmpDir);
            const now = Date.now();
            
            files.forEach(file => {
                const filePath = path.join(tmpDir, file);
                const stats = fs.statSync(filePath);
                // Delete files older than 1 hour
                if (now - stats.mtimeMs > 3600000) {
                    fs.unlinkSync(filePath);
                }
            });
        } catch (error) {
            console.error('Error cleaning temp directory:', error);
        }
    }, 3600000); // Run cleanup every hour
}).catch(err => {
    console.error('Failed to start bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
