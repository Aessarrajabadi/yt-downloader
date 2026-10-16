const express = require('express');
const { spawn } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let FFMPEG = null;
try { FFMPEG = require('ffmpeg-static'); } catch { /* system ffmpeg fallback */ }

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIES = process.env.COOKIES_FILE;
const MAX_JOBS = Number(process.env.MAX_JOBS || 3);

// ---------- yt-dlp auto setup ----------
const BIN_DIR = path.join(__dirname, 'bin');
const ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform] || 'yt-dlp';
const LOCAL_YTDLP = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let YTDLP = process.env.YTDLP_PATH || LOCAL_YTDLP;

function download(url, dest, hops = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'yt-downloader' } }, r => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops > 0) {
        r.resume();
        return download(new URL(r.headers.location, url).href, dest, hops - 1).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const tmp = dest + '.tmp';
      const f = fs.createWriteStream(tmp);
      r.pipe(f);
      f.on('finish', () => f.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      f.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureYtdlp() {
  if (process.env.YTDLP_PATH) return;
  if (!fs.existsSync(LOCAL_YTDLP)) {
    console.log('yt-dlp download ho raha hai (sirf pehli baar)...');
    fs.mkdirSync(BIN_DIR, { recursive: true });
    await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`, LOCAL_YTDLP);
    if (process.platform !== 'win32') fs.chmodSync(LOCAL_YTDLP, 0o755);
    console.log('yt-dlp ready ✓');
  } else {
    // background update (YouTube changes ke liye)
    spawn(LOCAL_YTDLP, ['-U'], { stdio: 'ignore' }).on('error', () => {});
  }
}

// ---------- helpers ----------
app.use(express.static(path.join(__dirname, 'public')));

const YT_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?.*v=|shorts\/|embed\/|live\/)|youtu\.be\/)[\w-]{11}/;

function baseArgs() {
  const a = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node'];
  if (FFMPEG) a.push('--ffmpeg-location', FFMPEG);
  if (COOKIES && fs.existsSync(COOKIES)) a.push('--cookies', COOKIES);
  return a;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args);
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => reject(new Error(
      e.code === 'ENOENT' ? 'yt-dlp nahi mila. Server restart karo (internet on rakho), woh khud download karega.' : e.message
    )));
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(cleanErr(err)))));
  });
}

function cleanErr(err) {
  const line = err.trim().split('\n').filter(Boolean).pop() || 'Download failed';
  if (/Sign in to confirm|bot/i.test(line)) return 'YouTube ne server block kiya (bot check). cookies.txt set karo — README dekho.';
  if (/Private video|unavailable/i.test(line)) return 'Video private ya unavailable hai.';
  return line.replace(/^ERROR:\s*/, '');
}

// ---------- Video info ----------
app.get('/api/info', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!YT_RE.test(url)) return res.status(400).json({ error: 'Valid YouTube video/Shorts link dalo' });
  try {
    const j = JSON.parse(await run([...baseArgs(), '-J', url]));
    const heights = [...new Set(
      (j.formats || []).filter(f => f.vcodec && f.vcodec !== 'none' && f.height).map(f => f.height)
    )].filter(h => h <= 2160).sort((a, b) => b - a);
    res.json({
      id: j.id,
      title: j.title,
      thumbnail: j.thumbnail,
      duration: j.duration,
      channel: j.channel || j.uploader,
      isShort: url.includes('/shorts/') || (j.duration <= 180 && j.height > j.width),
      qualities: heights,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Download ----------
let active = 0;
app.get('/api/download', async (req, res) => {
  const url = String(req.query.url || '').trim();
  const type = req.query.type === 'mp3' ? 'mp3' : 'mp4';
  const q = Math.min(parseInt(req.query.q, 10) || 720, 2160);
  if (!YT_RE.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  if (active >= MAX_JOBS) return res.status(429).json({ error: 'Server busy hai, 1 minute baad try karo' });

  active++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-' + crypto.randomBytes(3).toString('hex')));
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    active--;
    fs.rm(dir, { recursive: true, force: true }, () => {});
  };

  const args = [...baseArgs(), '--restrict-filenames', '-o', path.join(dir, '%(title).80s.%(ext)s')];
  if (type === 'mp3') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push('-f', 'bv*+ba/b', '-S', `res:${q},vcodec:h264,acodec:m4a`, '--merge-output-format', 'mp4');
  }
  args.push(url);

  try {
    await run(args);
    const file = fs.readdirSync(dir).find(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));
    if (!file) throw new Error('File generate nahi hui');
    res.download(path.join(dir, file), file, cleanup);
    res.on('close', cleanup);
  } catch (e) {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, active, ytdlp: YTDLP, ffmpeg: FFMPEG || 'system' }));

ensureYtdlp()
  .catch(e => {
    console.error('yt-dlp auto-download fail:', e.message, '— PATH wala yt-dlp try karenge.');
    YTDLP = 'yt-dlp';
  })
  .finally(() => app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`)));
