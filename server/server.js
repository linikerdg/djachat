// DJAchat — servidor (Node.js puro, sem dependências)
// Uso:  node server.js            (porta 3000, senha gerada e mostrada ao iniciar)
//       PORT=4000 SENHA=minhasenha node server.js
//       SEM_SENHA=1 node server.js  (só em rede de confiança)
//       LIMITE_DISCO_GB=50 node server.js  (padrão: 20 GB de uploads)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { criarOneDrive } = require('./onedrive');
const { iniciarTunel } = require('./tunel');

const PORT = Number(process.env.PORT) || 3000;
const TUNEL = process.env.TUNEL === '1';
const HOST = process.env.HOST || (TUNEL ? '127.0.0.1' : undefined);   // no túnel, só ele alcança o servidor
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const MAX_FILE = 500 * 1024 * 1024;   // 500 MB por arquivo
const MAX_SOUND = 3 * 1024 * 1024;    // 3 MB por som do soundboard
const HISTORY = 200;                  // mensagens enviadas ao abrir um canal
const MAX_DISK = (Number(process.env.LIMITE_DISCO_GB) || 20) * 1024 ** 3;
const MAX_WS = 1024 * 1024;           // 1 MB por mensagem do WebSocket
const MAX_ONEDRIVE = (Number(process.env.LIMITE_ONEDRIVE_GB) || 200) * 1024 ** 3;
const ONEDRIVE_CLIENT_ID = process.env.ONEDRIVE_CLIENT_ID || '6dd8bd2c-4c31-4cfe-9518-4b2ef8dad356';   // identificador público do app
const BACKUPS = 30;                   // cópias das conversas mantidas no OneDrive

fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------------------------------------------------------------- senha e segredo
// config.json fica em data/, fora do git: a senha gerada nunca vai para o repositório
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let config = {};
try { config = { ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { /* primeiro uso */ }
const configAntes = JSON.stringify(config);
config.segredo ||= crypto.randomBytes(32).toString('hex');
const SEM_SENHA = process.env.SEM_SENHA === '1';
if (!SEM_SENHA && !process.env.SENHA) config.senha ||= crypto.randomBytes(6).toString('hex');
const salvarConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
if (JSON.stringify(config) !== configAntes) salvarConfig();

const oneDrive = criarOneDrive({
  clientId: ONEDRIVE_CLIENT_ID,
  obterRefresh: () => config.onedrive && config.onedrive.refresh_token,
  salvarRefresh: (refresh_token) => { config.onedrive = { refresh_token }; salvarConfig(); },
});

// ---------------------------------------------------------------- ICE (STUN e TURN)
const STUN = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
let iceServers = [STUN];

async function atualizarIce() {
  if (!config.turn) return;
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${config.turn.id}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { authorization: `Bearer ${config.turn.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const dica = r.status === 404 ? ' (confira o Turn Token ID, que deve vir primeiro no comando)' : r.status === 401 || r.status === 403 ? ' (confira o API Token)' : '';
    throw new Error(`TURN recusado: HTTP ${r.status}${dica}`);
  }
  const servidores = [].concat((await r.json()).iceServers).map((s) => ({
    ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),   // navegadores bloqueiam a porta 53
  }));
  iceServers = [STUN, ...servidores];
  broadcast({ t: 'ice', ice: iceServers });
}
const renovarIce = () => atualizarIce().catch((e) => console.error('Falha ao obter o TURN:', e.message));

const SENHA = SEM_SENHA ? '' : process.env.SENHA || config.senha;
const derivar = (uso) => crypto.createHmac('sha256', config.segredo).update(`${uso}:${SENHA}`).digest('hex');
const SESSAO = derivar('sessao');           // guardada no app no lugar da senha
const TOKEN_ARQUIVOS = derivar('arquivos'); // estável entre conexões; muda junto com a senha

function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// ---------------------------------------------------------------- banco (JSON)
let db = {
  channels: [
    { id: 'geral', name: 'geral', kind: 'text' },
    { id: 'memes', name: 'memes', kind: 'text' },
    { id: 'voz-1', name: 'Sala 1', kind: 'voice' },
    { id: 'voz-2', name: 'Sala 2', kind: 'voice' },
  ],
  messages: {},   // channelId -> [message]
  files: {},      // fileId -> { name, size, mime }
  sounds: [],     // { id, name, fileId, emoji }
};
if (fs.existsSync(DB_FILE)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    // nunca sobrescreve um banco ilegível: guarda uma cópia antes de começar do zero
    const copia = `${DB_FILE}.corrompido-${Date.now()}`;
    fs.copyFileSync(DB_FILE, copia);
    console.error(`\n  ATENÇÃO: não consegui ler o db.json (${e.message}).`);
    console.error(`  Uma cópia foi guardada em: ${copia}\n`);
  }
}
// sem protótipo: chaves como "__proto__" ou "constructor" vindas da rede não acham nada
db.messages = Object.assign(Object.create(null), db.messages);
db.files = Object.assign(Object.create(null), db.files);

// um erro inesperado não pode derrubar a sala de todo mundo
process.on('uncaughtException', (e) => console.error('Erro inesperado:', e));
process.on('unhandledRejection', (e) => console.error('Promessa rejeitada:', e));

let saveTimer = null;
function save(delay = 300) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      // no Windows o antivírus pode travar o arquivo por um instante
      console.error('Falha ao salvar o banco, tentando de novo:', e.message);
      save(5000);
    }
  }, delay);
}

const anexos = (msgs) => msgs.flatMap((m) => (m.attachments || []).map((a) => a.id));

// apaga do disco os arquivos da lista que nenhuma mensagem ou som usa mais
function purgeFiles(ids) {
  const emUso = new Set(db.sounds.map((s) => s.fileId));
  for (const list of Object.values(db.messages)) for (const id of anexos(list)) emUso.add(id);
  let mudou = false;
  for (const id of ids) {
    if (!db.files[id] || emUso.has(id)) continue;
    const f = db.files[id];
    delete db.files[id];
    const avisar = (e) => console.error('Falha ao apagar no OneDrive:', e.message);
    if (f.remote) oneDrive.apagar(f.pasta || f.remote).catch(avisar);
    else fs.rm(path.join(FILES_DIR, id), () => {});
    if (f.backup) oneDrive.apagarCaminho(`backups/sons/${id}`).catch(avisar);
    mudou = true;
  }
  if (mudou) save();
}
purgeFiles(Object.keys(db.files));   // uploads que nunca viraram mensagem

const uid = () => crypto.randomBytes(8).toString('hex');
const str = (v) => (typeof v === 'string' ? v : '');
const COLORS = ['#e8a58f', '#e3c26f', '#8fd0a8', '#86d0c4', '#a3bde3', '#e0a6c6', '#bcabe6', '#add08a', '#e8bc8c', '#e8a0a0'];   // legíveis no fundo azul-marinho

// ---------------------------------------------------------------- estado em memória
const clients = new Map();  // id -> { id, ip, name, color, sock, voice, muted, deafened, sharing }
const tentativas = new Map();  // ip -> { n, ate, em } (senhas erradas)

const publicUser = (c) => ({ id: c.id, name: c.name, color: c.color, voice: c.voice, muted: c.muted, deafened: c.deafened, sharing: c.sharing });
const users = () => [...clients.values()].filter((c) => c.name).map(publicUser);

function send(c, obj) { if (c && c.sock) wsSend(c.sock, JSON.stringify(obj)); }
function broadcast(obj, filter) {
  const s = JSON.stringify(obj);
  for (const c of clients.values()) if (c.name && (!filter || filter(c))) wsSend(c.sock, s);
}
const pushUsers = () => broadcast({ t: 'users', users: users() });

// ---------------------------------------------------------------- protocolo
function onMessage(c, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;

  if (m.t === 'hello') {
    if (SENHA) {
      const agora = Date.now();
      const t = tentativas.get(c.ip) || { n: 0, ate: 0, em: agora };
      if (t.ate > agora) return send(c, { t: 'error', code: 'senha', message: 'Muitas tentativas erradas. Espere um minuto.' });
      if (!igual(m.password, SENHA) && !igual(m.session, SESSAO)) {
        t.n++; t.em = agora;
        if (t.n >= 5) { t.n = 0; t.ate = agora + 60000; }
        tentativas.set(c.ip, t);
        return send(c, { t: 'error', code: 'senha', message: 'Senha incorreta' });
      }
      tentativas.delete(c.ip);
    }
    c.name = str(m.name).trim().slice(0, 32) || 'Anônimo';
    c.color = COLORS[[...c.name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
    send(c, { t: 'welcome', you: publicUser(c), token: TOKEN_ARQUIVOS, session: SESSAO, ice: iceServers, channels: db.channels, sounds: db.sounds, users: users() });
    pushUsers();
    return;
  }
  if (!c.name) return; // não autenticado

  switch (m.t) {
    case 'history': {
      const list = db.messages[m.channel] || [];
      send(c, { t: 'history', channel: m.channel, messages: list.slice(-HISTORY) });
      break;
    }
    case 'msg': {
      const ch = db.channels.find((x) => x.id === m.channel && x.kind === 'text');
      if (!ch) return;
      const text = str(m.text).slice(0, 4000);
      const attachments = (Array.isArray(m.attachments) ? m.attachments : [])
        .filter((a) => a && typeof a.id === 'string' && db.files[a.id]).slice(0, 10)
        .map((a) => { const { name, size, mime } = db.files[a.id]; return { id: a.id, name, size, mime }; });
      if (!text.trim() && !attachments.length) return;
      const msg = { id: uid(), channel: ch.id, authorId: c.id, author: c.name, color: c.color, text, attachments, ts: Date.now() };
      (db.messages[ch.id] ||= []).push(msg);
      if (db.messages[ch.id].length > 5000) purgeFiles(anexos(db.messages[ch.id].splice(0, 1000)));
      save();
      broadcast({ t: 'msg', message: msg });
      break;
    }
    case 'typing':
      broadcast({ t: 'typing', channel: m.channel, id: c.id, name: c.name }, (o) => o !== c);
      break;
    case 'channel_create': {
      const name = str(m.name).trim().slice(0, 40);
      if (!name) return;
      const kind = m.kind === 'voice' ? 'voice' : 'text';
      db.channels.push({ id: uid(), name: kind === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name, kind });
      save();
      broadcast({ t: 'channels', channels: db.channels });
      break;
    }
    case 'channel_delete': {
      const i = db.channels.findIndex((x) => x.id === m.id);
      if (i < 0) return;
      const [ch] = db.channels.splice(i, 1);
      const arquivos = anexos(db.messages[ch.id] || []);
      delete db.messages[ch.id];
      purgeFiles(arquivos);
      save();
      for (const o of clients.values()) if (o.voice === ch.id) leaveVoice(o, false);
      broadcast({ t: 'channels', channels: db.channels });
      pushUsers();
      break;
    }
    case 'voice_join': {
      const ch = db.channels.find((x) => x.id === m.channel && x.kind === 'voice');
      if (!ch) return;
      if (c.voice) leaveVoice(c, false, false);
      const peers = [...clients.values()].filter((o) => o.voice === ch.id).map((o) => o.id);
      c.voice = ch.id; c.sharing = false;
      send(c, { t: 'voice_joined', channel: ch.id, peers });
      pushUsers();
      break;
    }
    case 'voice_leave':
      leaveVoice(c, true);
      break;
    case 'voice_state':
      c.muted = !!m.muted; c.deafened = !!m.deafened; c.sharing = !!m.sharing;
      pushUsers();
      break;
    case 'signal': {
      const o = clients.get(m.to);
      if (o && o.voice && o.voice === c.voice) send(o, { t: 'signal', from: c.id, data: m.data });
      break;
    }
    case 'sound_play': {
      const s = db.sounds.find((x) => x.id === m.id);
      if (!s || !c.voice) return;
      broadcast({ t: 'sound_play', id: s.id, by: c.name }, (o) => o.voice === c.voice);
      break;
    }
    case 'sound_delete': {
      const i = db.sounds.findIndex((x) => x.id === m.id);
      if (i < 0) return;
      const [som] = db.sounds.splice(i, 1);
      purgeFiles([som.fileId]);
      save();
      broadcast({ t: 'sounds', sounds: db.sounds });
      break;
    }
  }
}

function leaveVoice(c, notify, tellSelf = true) {
  if (!c.voice) return;
  const ch = c.voice;
  c.voice = null; c.sharing = false;
  broadcast({ t: 'peer_left', id: c.id, channel: ch }, (o) => o.voice === ch);
  if (tellSelf) send(c, { t: 'voice_left' });
  if (notify) pushUsers();
}

function onClose(c) {
  if (c.closed) return;
  c.closed = true;
  if (c.voice) leaveVoice(c, false);
  clients.delete(c.id);
  pushUsers();
}

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-token, x-filename, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const authed = (token) => igual(token, TOKEN_ARQUIVOS);
const espacoUsado = (remoto = false) => Object.values(db.files).reduce((total, f) => total + (!!f.remote === remoto ? f.size : 0), 0);
const limparNome = (v) => path.basename(v).slice(0, 120) || 'arquivo';
const envios = new Map();   // id -> envio direto ao OneDrive ainda não concluído

function lerJson(req) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; if (corpo.length > 16384) { req.destroy(); reject(new Error('corpo grande demais')); } });
    req.on('end', () => { try { resolve(JSON.parse(corpo) || {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// O navegador envia direto para o OneDrive; o servidor só autoriza e confere no fim
async function iniciarEnvio(req, res) {
  const b = await lerJson(req);
  const size = Number(b.size), name = limparNome(str(b.name)), mime = str(b.mime).slice(0, 100) || 'application/octet-stream';
  if (!oneDrive.ativo || !Number.isSafeInteger(size) || size <= 0) return json(res, 200, { local: true });
  if (size > MAX_FILE) return json(res, 413, { error: 'arquivo grande demais' });
  if (espacoUsado(true) + size > MAX_ONEDRIVE) return json(res, 507, { error: 'o espaço de uploads no OneDrive acabou' });
  try {
    const id = uid();
    const uploadUrl = await oneDrive.criarEnvio(id, name);
    envios.set(id, { name, size, mime, ate: Date.now() + 24 * 3600000 });
    json(res, 200, { id, uploadUrl });
  } catch (e) {
    console.error('OneDrive indisponível, usando o servidor:', e.message);
    json(res, 200, { local: true });
  }
}

async function concluirEnvio(req, res) {
  const { id } = await lerJson(req);
  const envio = typeof id === 'string' && envios.get(id);
  if (!envio) return json(res, 404, { error: 'envio não encontrado' });
  const item = await oneDrive.detalhes(id, envio.name);
  envios.delete(id);
  if (item.size !== envio.size) {
    await oneDrive.apagar(item.parentReference.id);
    return json(res, 400, { error: 'o arquivo chegou incompleto' });
  }
  db.files[id] = { name: envio.name, size: envio.size, mime: envio.mime, remote: item.id, pasta: item.parentReference.id };
  save();
  json(res, 200, { id, name: envio.name, size: envio.size, mime: envio.mime });
}

function tratar(res, promessa) {
  promessa.catch((e) => {
    console.error('Erro na API de envio:', e.message);
    if (!res.headersSent) json(res, 502, { error: 'falha ao falar com o OneDrive' });
  });
}

// O app abre de file://; dependendo da versão, o Chromium envia "file://" ou "null".
// "null" também pode vir de iframe isolado em site externo, mas aí a senha ainda barra.
function origemPermitida(origin, host) {
  if (!origin || origin === 'file://' || origin === 'null') return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

const server = http.createServer((req, res) => {
  try { handleRequest(req, res); }
  catch (e) {
    console.error('Erro em', req.method, req.url, e);
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
});
server.requestTimeout = 0;   // o limite padrão de 5 min cortaria uploads grandes; ver req.setTimeout abaixo
server.on('error', (e) => { console.error(`Não consegui iniciar o servidor: ${e.message}`); process.exit(1); });

function handleRequest(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && (url.pathname === '/api/upload/iniciar' || url.pathname === '/api/upload/concluir')) {
    if (!authed(req.headers['x-token'])) return json(res, 401, { error: 'não autenticado' });
    return tratar(res, url.pathname.endsWith('iniciar') ? iniciarEnvio(req, res) : concluirEnvio(req, res));
  }

  // Upload: POST /api/upload?kind=file|sound&emoji=🔊   (corpo = bytes do arquivo)
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    if (!authed(req.headers['x-token'])) return json(res, 401, { error: 'não autenticado' });
    const kind = url.searchParams.get('kind') === 'sound' ? 'sound' : 'file';
    const limit = kind === 'sound' ? MAX_SOUND : MAX_FILE;
    let name = 'arquivo';
    try { name = decodeURIComponent(req.headers['x-filename'] || 'arquivo'); } catch { /* nome inválido */ }
    name = limparNome(name);
    const mime = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
    if (kind === 'sound' && !mime.startsWith('audio/')) return json(res, 400, { error: 'o som precisa ser um arquivo de áudio' });
    if (Number(req.headers['content-length']) > limit) return json(res, 413, { error: 'arquivo grande demais' });
    if (espacoUsado() + (Number(req.headers['content-length']) || 0) > MAX_DISK) return json(res, 507, { error: 'o espaço de uploads do servidor acabou' });

    const id = uid();
    const dest = path.join(FILES_DIR, id);
    const out = fs.createWriteStream(dest);
    let size = 0, aborted = false;
    req.setTimeout(120000, () => req.destroy(new Error('upload parado')));   // só derruba quem parou de enviar
    out.on('error', (e) => {
      if (aborted) return;
      aborted = true;
      console.error('Falha ao gravar upload:', e.message);
      fs.rm(dest, () => {});
      if (!res.headersSent) json(res, 500, { error: 'o servidor não conseguiu gravar o arquivo' });
      req.destroy();
    });
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit && !aborted) {
        aborted = true; out.destroy(); fs.rm(dest, () => {});
        json(res, 413, { error: 'arquivo grande demais' }); req.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      db.files[id] = { name, size, mime };
      if (kind === 'sound') {
        const emoji = [...String(url.searchParams.get('emoji') || '🔊')].slice(0, 2).join('');
        db.sounds.push({ id: uid(), name: name.replace(/\.[^.]+$/, '').slice(0, 30), fileId: id, emoji });
        broadcast({ t: 'sounds', sounds: db.sounds });
      }
      save();
      json(res, 200, { id, name, size, mime });
    });
    req.on('error', () => { out.destroy(); fs.rm(dest, () => {}); });
    return;
  }

  // Download: GET /files/<id>?t=<token>[&download=1]
  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    if (!authed(url.searchParams.get('t'))) { res.writeHead(401); return res.end(); }
    const id = url.pathname.slice(7);
    const f = /^[a-f0-9]{16}$/.test(id) && db.files[id];
    if (!f) { res.writeHead(404); return res.end(); }
    if (f.remote) {
      return tratar(res, oneDrive.link(f.remote).then((link) => {
        res.writeHead(302, { Location: link, 'Cache-Control': 'no-store' });
        res.end();
      }));
    }
    // o tipo vem de quem enviou: HTML, SVG e afins só saem como download, nunca como página
    const exibivel = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/|audio\/)/i.test(f.mime);
    const disp = url.searchParams.get('download') || !exibivel ? 'attachment' : 'inline';
    const filePath = path.join(FILES_DIR, id);
    return fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
      const headers = {
        'Content-Type': f.mime, 'Accept-Ranges': 'bytes',
        'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Cache-Control': 'private, max-age=31536000',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox',
      };
      if (st.size === 0) { res.writeHead(200, { ...headers, 'Content-Length': 0 }); return res.end(); }

      // Range: permite avançar vídeos e áudios sem baixar tudo
      let start = 0, end = st.size - 1, status = 200;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        if (range[1]) {
          start = Number(range[1]);
          if (range[2]) end = Math.min(Number(range[2]), end);
        } else {
          start = Math.max(st.size - Number(range[2]), 0);
        }
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
      headers['Content-Length'] = end - start + 1;

      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', (e) => { console.error('Falha ao ler arquivo:', e.message); res.destroy(); });
      res.on('close', () => stream.destroy());
      res.writeHead(status, headers);
      stream.pipe(res);
    });
  }

  if (url.pathname === '/api/info') return json(res, 200, { name: 'djachat', senha: !!SENHA });

  // Arquivos do cliente (útil para testar pelo navegador em localhost)
  let p;
  try { p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''); }
  catch { res.writeHead(400); return res.end(); }
  if (!p || p === '.') p = 'index.html';
  const file = path.join(CLIENT_DIR, p);
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- WebSocket (RFC 6455, mínimo)
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return sock.destroy();
  if (!origemPermitida(req.headers.origin, req.headers.host)) return sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);

  const ip = (TUNEL && req.headers['cf-connecting-ip']) || sock.remoteAddress;   // o túnel informa o IP real de quem conecta
  const c = { id: uid(), ip, sock, voice: null, muted: false, deafened: false, sharing: false, alive: true };
  clients.set(c.id, c);
  let buf = Buffer.alloc(0);
  let frag = [], fragSize = 0;
  const semLogin = setTimeout(() => { if (!c.name) sock.destroy(); }, 15000);   // conexão que não entra não fica aberta

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (fragSize + len > MAX_WS) return sock.destroy();
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 0x8) { wsFrame(sock, 0x8, Buffer.alloc(0)); sock.end(); return; }
      if (op === 0x9) { wsFrame(sock, 0xA, payload); continue; }
      if (op === 0xA) { c.alive = true; continue; }
      if (op === 0x1 || op === 0x0) {
        frag.push(payload); fragSize += payload.length;
        if (fin) {
          const text = Buffer.concat(frag).toString('utf8'); frag = []; fragSize = 0;
          try { onMessage(c, text); } catch (e) { console.error('Erro ao processar mensagem:', e); }
        }
      }
    }
  });
  sock.on('close', () => { clearTimeout(semLogin); onClose(c); });
  sock.on('error', () => onClose(c));
});

function wsFrame(sock, op, payload) {
  if (sock.destroyed) return;
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  sock.write(Buffer.concat([head, payload]));
}
function wsSend(sock, text) { wsFrame(sock, 0x1, Buffer.from(text, 'utf8')); }

// ping a cada 25 s; derruba conexões mortas
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.sock.destroy(); onClose(c); continue; }
    c.alive = false;
    wsFrame(c.sock, 0x9, Buffer.alloc(0));
  }
  for (const [ip, t] of tentativas) if (Date.now() - t.em > 10 * 60000) tentativas.delete(ip);
  for (const [id, e] of envios) if (e.ate < Date.now()) envios.delete(id);
}, 25000);

// ---------------------------------------------------------------- backup no OneDrive
let ultimoBackup = '';
async function fazerBackup() {
  if (!oneDrive.ativo) return;
  const dados = JSON.stringify(db);
  if (dados !== ultimoBackup) {
    await oneDrive.gravar(`backups/db-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, dados);
    ultimoBackup = dados;
    const copias = (await oneDrive.listar('backups')).filter((i) => i.name.startsWith('db-')).sort((a, b) => b.name.localeCompare(a.name));
    for (const velha of copias.slice(BACKUPS)) await oneDrive.apagar(velha.id);
  }
  for (const s of db.sounds) {
    const f = db.files[s.fileId];
    if (!f || f.remote || f.backup) continue;
    await oneDrive.gravar(`backups/sons/${s.fileId}`, await fs.promises.readFile(path.join(FILES_DIR, s.fileId)));
    f.backup = true;
    save();
  }
}
const backup = () => fazerBackup().catch((e) => console.error('Falha no backup do OneDrive:', e.message));

if (process.argv.includes('--conectar-onedrive')) {
  oneDrive.conectar(console.log)
    .then(() => { console.log('  OneDrive conectado. Agora é só iniciar o servidor normalmente.\n'); process.exit(0); })
    .catch((e) => { console.error(`  Não consegui conectar: ${e.message}`); process.exit(1); });
} else if (process.argv.includes('--configurar-turn')) {
  const i = process.argv.indexOf('--configurar-turn');
  config.turn = { id: process.argv[i + 1], token: process.argv[i + 2] };
  atualizarIce()
    .then(() => { salvarConfig(); console.log('\n  TURN configurado.\n'); process.exit(0); })
    .catch((e) => { console.error(`  Não consegui configurar o TURN: ${e.message}`); process.exit(1); });
} else server.listen(PORT, HOST, () => {
  setTimeout(backup, 60000);
  setInterval(backup, 6 * 3600000);
  renovarIce();
  setInterval(renovarIce, 12 * 3600000);
  if (TUNEL) {
    iniciarTunel(PORT,
      (url) => console.log(`\n  ==== Endereço para os amigos: ${url} ====\n`),
      (m) => console.error(`  ${m}`));
  }
  const nets = require('os').networkInterfaces();
  const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log(`\n  DJAchat rodando na porta ${PORT}${SENHA ? ' (com senha)' : ''}`);
  if (TUNEL) console.log('  Abrindo o endereço público...');
  else {
    console.log('  Endereços para os amigos:');
    for (const ip of ips) console.log(`    ${ip}:${PORT}`);
  }
  if (!SENHA) console.log('\n  ATENÇÃO: servidor SEM senha. Use só em rede de confiança.');
  else if (!process.env.SENHA) console.log(`\n  Senha do servidor: ${SENHA}`);
  console.log(`  OneDrive: ${oneDrive.ativo ? 'conectado' : 'desligado (arquivos ficam neste servidor)'}`);
  if (TUNEL && !config.turn) console.log('  TURN: não configurado (a voz pode falhar entre algumas conexões)');
  console.log('');
});
