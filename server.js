const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'db.json');
const ADMIN_PASS = process.env.ADMIN_PASS || 'campus2026';

// --- DATOS INICIALES POR DEFECTO ---
const defaultDB = {
  config: {
    campusName: 'Radio Campus Central',
    roundDurationSec: 45,
    tieBreaker: 'random',
    lat: 22.2553,
    lon: -97.8686,
    isPaused: false,
    announcementIntervalSongs: 2,
    savedPlaylistUrl: ''
  },
  songs: [
    { id: '1', title: 'Lo-Fi Study Beats', artist: 'Chillhop', youtubeId: 'jfKfPfyJRdk', genre: 'Lo-Fi', energy: 'baja', mood: 'concentracion', theme: 'examenes', allowed: true, isBackup: true },
    { id: '2', title: 'Weightless Ambient', artist: 'Marconi Union', youtubeId: 'UfcAVejslrU', genre: 'Ambient', energy: 'baja', mood: 'relajado', theme: 'examenes', allowed: true, isBackup: true },
    { id: '3', title: 'Blinding Lights', artist: 'The Weeknd', youtubeId: '4NRXx6U8ABQ', genre: 'Pop', energy: 'alta', mood: 'energetico', theme: 'normal', allowed: true, isBackup: true },
    { id: '4', title: 'Levitating', artist: 'Dua Lipa', youtubeId: 'TUVcZfQe-Kw', genre: 'Pop', energy: 'alta', mood: 'fiesta', theme: 'normal', allowed: true, isBackup: false },
    { id: '5', title: 'Sunflower', artist: 'Post Malone', youtubeId: 'ApXoWvfEYVU', genre: 'Hip-Hop', energy: 'media', mood: 'alegre', theme: 'normal', allowed: true, isBackup: true },
    { id: '6', title: 'Viva La Vida', artist: 'Coldplay', youtubeId: 'dvgZkm1xWPE', genre: 'Rock', energy: 'media', mood: 'epico', theme: 'aniversario', allowed: true, isBackup: false }
  ],
  rules: [
    { id: 'r1', name: 'Periodo de Exámenes', priority: 100, conditionType: 'event', conditionValue: 'examenes', targetEnergy: 'baja', targetTheme: 'examenes' },
    { id: 'r2', name: 'Aniversario Universitario', priority: 90, conditionType: 'event', conditionValue: 'aniversario', targetEnergy: 'media', targetTheme: 'aniversario' },
    { id: 'r3', name: 'Mañana Tranquila (06:00 - 11:59)', priority: 50, conditionType: 'time', conditionValue: 'morning', targetEnergy: 'media', targetTheme: '' },
    { id: 'r4', name: 'Tarde Dinámica (12:00 - 18:59)', priority: 50, conditionType: 'time', conditionValue: 'afternoon', targetEnergy: 'alta', targetTheme: '' },
    { id: 'r5', name: 'Calor Extremo (> 30°C)', priority: 60, conditionType: 'temp_gt', conditionValue: '30', targetEnergy: 'alta', targetTheme: '' }
  ],
  events: [
    { id: 'e1', name: 'Semana de Parciales', date: '2026-11-20', tag: 'examenes' }
  ],
  announcements: [
    { id: 'a1', text: 'Recuerda escanear el código QR en pantalla para elegir la próxima canción de Radio Campus.', active: true, expiresAt: '2027-12-31' },
    { id: 'a2', text: 'Atención estudiantes: las inscripciones a los talleres culturales cierran este viernes en coordinación.', active: true, expiresAt: '2027-12-31' }
  ],
  history: []
};

let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : defaultDB;
if (db.config.savedPlaylistUrl === undefined) db.config.savedPlaylistUrl = '';

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
if (!fs.existsSync(DB_FILE)) saveDB();

// --- ESTADO EN TIEMPO REAL ---
let state = {
  weather: { temp: 26, status: 'Despejado' },
  activeRule: 'Normal',
  currentSong: db.songs[2] || db.songs[0],
  options: [db.songs[0], db.songs[1] || db.songs[0]],
  votes: { A: 0, B: 0 },
  voters: new Set(),
  timeLeft: db.config.roundDurationSec,
  lastWinnerText: '',
  songsSinceLastAd: 0,
  recentSongIds: []
};

// --- CONSULTA DE CLIMA (OPEN-METEO SIN API KEY) ---
async function updateWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${db.config.lat}&longitude=${db.config.lon}&current_weather=true`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.current_weather) {
      state.weather.temp = data.current_weather.temperature;
      state.weather.status = 'En línea';
    }
  } catch (e) {
    state.weather.status = 'Sin conexión (usando respaldo)';
  }
}
updateWeather();
setInterval(updateWeather, 15 * 60 * 1000);

// --- ALGORITMO CONTEXTUAL ---
function selectContextualOptions() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const hour = now.getHours();
  const timeSlot = hour < 12 ? 'morning' : (hour < 19 ? 'afternoon' : 'night');

  const todayEvent = db.events.find(e => e.date === todayStr);

  const matchingRules = db.rules
    .filter(r => {
      if (r.conditionType === 'event' && todayEvent && todayEvent.tag === r.conditionValue) return true;
      if (r.conditionType === 'time' && r.conditionValue === timeSlot) return true;
      if (r.conditionType === 'temp_gt' && state.weather.temp > parseFloat(r.conditionValue)) return true;
      if (r.conditionType === 'temp_lt' && state.weather.temp < parseFloat(r.conditionValue)) return true;
      return false;
    })
    .sort((a, b) => b.priority - a.priority);

  const topRule = matchingRules[0] || null;
  state.activeRule = topRule ? `${topRule.name} (Prioridad ${topRule.priority})` : 'Selección General';

  let eligible = db.songs.filter(s => s.allowed && s.id !== state.currentSong?.id && !state.recentSongIds.includes(s.id));

  if (topRule) {
    const strict = eligible.filter(s =>
      (!topRule.targetEnergy || s.energy === topRule.targetEnergy) &&
      (!topRule.targetTheme || s.theme === topRule.targetTheme)
    );
    if (strict.length >= 2) eligible = strict;
  }

  if (eligible.length < 2) {
    eligible = db.songs.filter(s => s.allowed && s.isBackup && s.id !== state.currentSong?.id);
    if (eligible.length < 2) eligible = db.songs.filter(s => s.allowed);
    state.activeRule += ' [Respaldo]';
  }

  const shuffled = [...eligible].sort(() => 0.5 - Math.random());
  return [shuffled[0], shuffled[1] || shuffled[0]];
}

// --- CICLO DE RONDA Y REPRODUCCIÓN ---
function startNextRound() {
  let winner = state.options[0];
  let reason = 'Mayoría de votos';

  if (state.votes.A > state.votes.B) {
    winner = state.options[0];
  } else if (state.votes.B > state.votes.A) {
    winner = state.options[1];
  } else {
    reason = state.votes.A === 0 ? 'Sin votos (Automático)' : 'Empate resuelto';
    winner = db.config.tieBreaker === 'optionA'
      ? state.options[0]
      : state.options[Math.floor(Math.random() * 2)];
  }

  db.history.unshift({
    date: new Date().toLocaleString(),
    song: `${winner.title} - ${winner.artist}`,
    votesA: state.votes.A,
    votesB: state.votes.B,
    rule: state.activeRule
  });
  if (db.history.length > 50) db.history.pop();
  saveDB();

  state.lastWinnerText = `Ganó: ${winner.title} (${reason})`;
  state.currentSong = winner;
  state.recentSongIds.push(winner.id);
  if (state.recentSongIds.length > 3) state.recentSongIds.shift();

  state.options = selectContextualOptions();
  state.votes = { A: 0, B: 0 };
  state.voters.clear();
  state.timeLeft = db.config.roundDurationSec;
  state.songsSinceLastAd++;

  let adToPlay = null;
  if (state.songsSinceLastAd >= db.config.announcementIntervalSongs) {
    const today = new Date().toISOString().split('T')[0];
    const validAds = db.announcements.filter(a => a.active && a.expiresAt >= today);
    if (validAds.length > 0) {
      adToPlay = validAds[Math.floor(Math.random() * validAds.length)];
      state.songsSinceLastAd = 0;
    }
  }

  io.emit('round_changed', {
    currentSong: state.currentSong,
    options: state.options,
    lastWinnerText: state.lastWinnerText,
    activeRule: state.activeRule,
    adToPlay
  });
}

setInterval(() => {
  if (db.config.isPaused) return;
  state.timeLeft--;
  if (state.timeLeft <= 0) {
    startNextRound();
  }
  io.emit('tick', {
    timeLeft: state.timeLeft,
    votes: state.votes,
    weather: state.weather,
    isPaused: db.config.isPaused
  });
}, 1000);

// --- ENDPOINTS PÚBLICOS ---
app.get('/api/state', (req, res) => {
  res.json({
    config: db.config,
    weather: state.weather,
    activeRule: state.activeRule,
    currentSong: state.currentSong,
    options: state.options,
    votes: state.votes,
    timeLeft: state.timeLeft,
    lastWinnerText: state.lastWinnerText,
    announcements: db.announcements.filter(a => a.active)
  });
});

app.get('/api/qr', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const voteUrl = `${protocol}://${host}/vote.html`;
  const qrDataUrl = await QRCode.toDataURL(voteUrl, { width: 300, margin: 1 });
  res.json({ qr: qrDataUrl, url: voteUrl });
});

app.post('/api/vote', (req, res) => {
  const { option, voterId } = req.body;
  if (db.config.isPaused) return res.status(400).json({ error: 'La radio está en pausa.' });
  if (state.timeLeft <= 1) return res.status(400).json({ error: 'La ronda acaba de cerrar.' });
  if (!voterId || state.voters.has(voterId)) {
    return res.status(400).json({ error: 'Ya registraste tu voto en esta ronda.' });
  }
  if (option !== 'A' && option !== 'B') return res.status(400).json({ error: 'Opción inválida.' });

  state.voters.add(voterId);
  state.votes[option]++;
  io.emit('vote_updated', state.votes);
  res.json({ ok: true, message: '¡Voto registrado con éxito!' });
});

// --- API ADMINISTRACIÓN ---
function auth(req, res, next) {
  if (req.headers['x-admin-pass'] !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) return res.json({ ok: true });
  res.status(401).json({ error: 'Contraseña incorrecta' });
});

app.get('/api/admin/data', auth, (req, res) => {
  res.json({ db, state: { currentSong: state.currentSong, activeRule: state.activeRule, weather: state.weather } });
});

app.post('/api/admin/save', auth, (req, res) => {
  const { section, data } = req.body;
  if (db[section] !== undefined) {
    db[section] = data;
    saveDB();
    io.emit('config_updated');
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'Sección inválida' });
  }
});

// --- SINCRONIZAR PLAYLIST DE YOUTUBE SIN API KEY ---
app.post('/api/admin/sync-playlist', auth, async (req, res) => {
  try {
    let { playlistUrl, replaceAll } = req.body;
    if (!playlistUrl) return res.status(400).json({ error: 'Debes ingresar el link o ID de la playlist.' });

    const match = playlistUrl.match(/[?&]list=([^&]+)/);
    const playlistId = match ? match[1] : playlistUrl.trim();

    const response = await fetch(`https://www.youtube.com/playlist?list=${playlistId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8'
      }
    });
    const html = await response.text();

    const dataMatch = html.match(/var ytInitialData = ({.*?});<\/script>/);
    if (!dataMatch) {
      return res.status(400).json({ error: 'No se pudo leer la playlist. Asegúrate de que sea Pública o No listada.' });
    }

    const ytData = JSON.parse(dataMatch[1]);

    // Buscador recursivo KISS: encuentra todos los videos sin importar la estructura del layout de YouTube
    function extractPlaylistVideos(obj, found = []) {
      if (!obj || typeof obj !== 'object') return found;
      if (obj.playlistVideoRenderer && obj.playlistVideoRenderer.videoId) {
        found.push(obj);
      } else {
        for (const key of Object.keys(obj)) {
          extractPlaylistVideos(obj[key], found);
        }
      }
      return found;
    }

    const contents = extractPlaylistVideos(ytData);

    // Fallback al feed XML público de YouTube si el HTML vino bloqueado o es playlist especial (ej. Mix/WL)
    if (contents.length === 0) {
      const xmlRes = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`);
      if (xmlRes.ok) {
        const xml = await xmlRes.text();
        const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
        for (const entry of entries) {
          const vId = (entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1];
          const vTitle = (entry.match(/<title>(.*?)<\/title>/) || [])[1];
          const vAuthor = (entry.match(/<name>(.*?)<\/name>/) || [])[1];
          if (vId) {
            contents.push({
              playlistVideoRenderer: {
                videoId: vId,
                title: { runs: [{ text: vTitle || 'Sin título' }] },
                shortBylineText: { runs: [{ text: vAuthor || 'YouTube' }] }
              }
            });
          }
        }
      }
    }

    if (contents.length === 0) {
      return res.status(400).json({ error: 'La playlist está vacía, es privada o es una lista automática (Mix/Ver más tarde) que YouTube no hace pública.' });
    }

    if (replaceAll) {
      db.songs = [];
    }

    let addedCount = 0;
    for (const item of contents) {
      const video = item.playlistVideoRenderer;
      if (!video || !video.videoId) continue;

      const exists = db.songs.some(s => s.youtubeId === video.videoId);
      if (exists) continue;

      const rawTitle = video.title?.runs?.[0]?.text || 'Sin título';
      const channelName = video.shortBylineText?.runs?.[0]?.text || 'YouTube';

      let artist = channelName.replace(' - Topic', '').trim();
      let title = rawTitle;
      if (rawTitle.includes(' - ')) {
        const parts = rawTitle.split(' - ');
        artist = parts[0].trim();
        title = parts.slice(1).join(' - ').trim();
      }

      db.songs.push({
        id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
        title,
        artist,
        youtubeId: video.videoId,
        genre: 'Playlist',
        energy: 'media',
        mood: 'general',
        theme: 'normal',
        allowed: true,
        isBackup: true
      });
      addedCount++;
    }

    // Guardar link en configuración para próximas actualizaciones con 1 clic
    db.config.savedPlaylistUrl = playlistUrl.trim();
    saveDB();

    // Si se reemplazó todo el catálogo, refrescar opciones actuales
    if (replaceAll && db.songs.length >= 2) {
      state.currentSong = db.songs[0];
      state.options = selectContextualOptions();
      io.emit('round_changed', {
        currentSong: state.currentSong,
        options: state.options,
        lastWinnerText: 'Catálogo actualizado desde Playlist',
        activeRule: state.activeRule,
        adToPlay: null
      });
    } else {
      io.emit('config_updated');
    }

    res.json({ ok: true, added: addedCount, totalDetected: contents.length });
  } catch (err) {
    res.status(500).json({ error: 'Error al conectar con YouTube: ' + err.message });
  }
});

app.post('/api/admin/action', auth, (req, res) => {
  const { action, payload } = req.body;
  if (action === 'toggle_pause') {
    db.config.isPaused = !db.config.isPaused;
    saveDB();
  } else if (action === 'skip_round') {
    startNextRound();
  } else if (action === 'play_song') {
    const song = db.songs.find(s => s.id === payload);
    if (song) {
      state.currentSong = song;
      state.options = selectContextualOptions();
      state.votes = { A: 0, B: 0 };
      state.voters.clear();
      state.timeLeft = db.config.roundDurationSec;
      io.emit('round_changed', {
        currentSong: state.currentSong,
        options: state.options,
        lastWinnerText: 'Intervención manual de cabina',
        activeRule: state.activeRule,
        adToPlay: null
      });
    }
  } else if (action === 'speak_now') {
    io.emit('force_speak', payload);
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`📻 Radio Campus corriendo en http://localhost:${PORT}`);
  console.log(`📺 Pantalla Pública: http://localhost:${PORT}/index.html`);
  console.log(`📱 Votación Móvil:   http://localhost:${PORT}/vote.html`);
  console.log(`⚙️  Panel Admin:      http://localhost:${PORT}/admin.html (Clave: ${ADMIN_PASS})`);
});