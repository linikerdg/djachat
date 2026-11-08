// DJAchat — cliente (roda no app desktop Electron ou no navegador em localhost)
'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem('djachat.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('djachat.' + k, JSON.stringify(v)); } catch { /* sem storage */ } },
};

const S = {
  base: '', ws: null, token: '', me: null, connected: false, wantVoice: null,
  ice: [{ urls: 'stun:stun.l.google.com:19302' }],   // o servidor envia STUN e TURN ao entrar
  pass: '',                // só em memória, até o servidor devolver a sessão
  speaking: new Set(),     // ids de quem está falando agora
  channels: [], users: [], sounds: [],
  current: null,           // canal de texto aberto
  view: 'text',            // 'text' | 'voice'
  messages: {},            // channelId -> [msg]
  loaded: new Set(),       // canais cujo histórico já veio do servidor
  unread: new Set(),
  typing: {},              // channelId -> { id: {name, until} }
  voice: null,             // id do canal de voz em que estou
  muted: LS.get('muted', false), deafened: false,
  mic: null,               // MediaStream do microfone (já processado)
  micRaw: null,
  screen: null,            // MediaStream da tela
  peers: new Map(),        // peerId -> peer
  audioCtx: null,
  sbVolume: LS.get('sbVolume', 0.6),
  userVol: LS.get('userVol', {}),
  inputId: LS.get('inputId', ''), outputId: LS.get('outputId', ''),
};

// ================================================================ conexão
function normalizeServer(v) {
  v = v.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(v)) {
    const local = /:\d+$/.test(v) || /^(localhost|\d+\.\d+\.\d+\.\d+)$/.test(v);
    v = (local ? 'http://' : 'https://') + v;   // domínios públicos usam HTTPS
  }
  return v;
}

function connect() {
  const wsUrl = S.base.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: LS.get('name', ''), password: S.pass, session: LS.get('session', '') }));
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false;
    $('#connDot').className = 'dot';
    $('#connDot').title = 'Reconectando…';
    if (S.voice) { S.wantVoice = S.voice; teardownVoice(); }
    if (S.me) setTimeout(() => { if (S.me) connect(); }, 2000);
    else { $('#lError').textContent = 'Não consegui conectar a ' + S.base; $('#login').classList.remove('hidden'); }
  };
}
const send = (obj) => {
  if (!S.ws || S.ws.readyState !== 1) return false;
  S.ws.send(JSON.stringify(obj));
  return true;
};

function handle(m) {
  switch (m.t) {
    case 'error':
      if (m.code === 'senha') { S.me = null; S.pass = ''; LS.set('session', ''); const w = S.ws; S.ws = null; w.close(); showLogin(); $('#lError').textContent = m.message; }
      else toast(m.message);
      break;
    case 'welcome': {
      S.connected = true; S.me = m.you; S.token = m.token;
      S.pass = ''; LS.set('session', m.session);
      if (m.ice) S.ice = m.ice;
      S.channels = m.channels; S.sounds = m.sounds; S.users = m.users;
      $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
      $('#connDot').className = 'dot ok'; $('#connDot').title = 'Conectado';
      $('#meName').textContent = S.me.name; paintAvatar($('#meAvatar'), S.me);
      S.messages = {}; S.loaded = new Set();
      const first = S.channels.find((c) => c.id === LS.get('lastChannel')) || S.channels.find((c) => c.kind === 'text');
      if (first) openText(first.id);
      renderChannels(); renderMembers(); renderSounds();
      if (S.wantVoice) { const v = S.wantVoice; S.wantVoice = null; joinVoice(v); }
      break;
    }
    case 'channels':
      S.channels = m.channels;
      if (S.current && !S.channels.find((c) => c.id === S.current)) {
        const f = S.channels.find((c) => c.kind === 'text'); if (f) openText(f.id);
      }
      renderChannels();
      break;
    case 'users': {
      const before = new Map(S.users.map((u) => [u.id, u]));
      S.users = m.users;
      for (const u of S.users) {
        const b = before.get(u.id);
        if (b && b.sharing && !u.sharing) removeScreenTile(u.id);
        if (S.voice && u.id !== S.me.id && u.voice === S.voice && (!b || b.voice !== S.voice)) playTone('join');
      }
      if (S.voice) for (const [id, b] of before) {
        if (id !== S.me.id && b.voice === S.voice && !S.users.find((u) => u.id === id && u.voice === S.voice)) playTone('leave');
      }
      renderChannels(); renderMembers(); renderVoiceView();
      break;
    }
    case 'history':
      S.messages[m.channel] = m.messages;
      S.loaded.add(m.channel);
      if (m.channel === S.current) renderMessages(true);
      break;
    case 'msg': {
      const msg = m.message;
      (S.messages[msg.channel] ||= []).push(msg);
      if (S.typing[msg.channel]) delete S.typing[msg.channel][msg.authorId];
      if (msg.channel === S.current && S.view === 'text') appendMessage(msg);
      else if (msg.authorId !== S.me.id) { S.unread.add(msg.channel); renderChannels(); }
      if (msg.authorId !== S.me.id && (!document.hasFocus() || msg.channel !== S.current)) {
        playTone('msg');
        if (window.djachatDesktop) window.djachatDesktop.flash();
      }
      renderTyping();
      break;
    }
    case 'typing':
      (S.typing[m.channel] ||= {})[m.id] = { name: m.name, until: Date.now() + 4000 };
      renderTyping();
      break;
    case 'ice': S.ice = m.ice; break;
    case 'sounds': S.sounds = m.sounds; renderSounds(); break;
    case 'sound_play': playSound(m.id); break;
    case 'voice_joined': startVoice(m.channel, m.peers); break;
    case 'voice_left': teardownVoice(); break;
    case 'peer_left': closePeer(m.id); break;
    case 'signal': onSignal(m.from, m.data); break;
  }
}

// ================================================================ login
function showLogin() {
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#lServer').value = LS.get('server', location.protocol.startsWith('http') ? location.host : '');
  $('#lName').value = LS.get('name', '');
  $('#lPass').value = '';
}
$('#loginForm').onsubmit = (e) => {
  e.preventDefault();
  $('#lError').textContent = 'Conectando…';
  if ($('#lServer').value.trim() !== LS.get('server')) LS.set('session', '');   // sessão só vale no servidor que a emitiu
  LS.set('server', $('#lServer').value.trim()); LS.set('name', $('#lName').value.trim());
  S.pass = $('#lPass').value;
  S.base = normalizeServer($('#lServer').value);
  S.me = null;
  if (S.ws) { const o = S.ws; S.ws = null; o.close(); }
  connect();
};

// ================================================================ canais
function renderChannels() {
  const tc = $('#textChannels'), vc = $('#voiceChannels');
  tc.replaceChildren(); vc.replaceChildren();
  for (const ch of S.channels) {
    const row = el('div', 'chan');
    row.append(el('span', 'hash', ch.kind === 'text' ? '#' : '🔊'), el('span', 'name', ch.name));
    const del = el('button', 'del', '✕'); del.title = 'Apagar canal';
    del.onclick = (e) => { e.stopPropagation(); confirmModal(`Apagar "${ch.name}"?`, 'As mensagens do canal serão perdidas.', () => send({ t: 'channel_delete', id: ch.id })); };
    row.append(del);
    if (ch.kind === 'text') {
      if (ch.id === S.current && S.view === 'text') row.classList.add('active');
      if (S.unread.has(ch.id)) row.classList.add('unread');
      row.onclick = () => openText(ch.id);
      tc.append(row);
    } else {
      if (ch.id === S.voice && S.view === 'voice') row.classList.add('active');
      row.onclick = () => (S.voice === ch.id ? showVoiceView() : joinVoice(ch.id));
      vc.append(row);
      const members = S.users.filter((u) => u.voice === ch.id);
      if (members.length) {
        const box = el('div', 'vmembers');
        for (const u of members) {
          const r = el('div', 'vmember'); r.dataset.uid = u.id;
          const av = el('div', 'avatar'); paintAvatar(av, u);
          r.append(av, el('span', null, u.name));
          const flags = el('span', 'flags');
          if (u.sharing) flags.append(el('span', 'live', 'AO VIVO'));
          if (u.deafened) flags.append(' 🙉'); else if (u.muted) flags.append(' 🔇');
          r.append(flags);
          box.append(r);
        }
        vc.append(box);
      }
    }
  }
  paintSpeaking();
}
document.querySelectorAll('.cat .add').forEach((b) => {
  b.onclick = () => {
    const kind = b.dataset.kind;
    promptModal(kind === 'text' ? 'Novo canal de texto' : 'Novo canal de voz', 'Nome do canal', '', (name) => send({ t: 'channel_create', name, kind }));
  };
});

function renderMembers() {
  const list = $('#memberList'); list.replaceChildren();
  $('#onlineCount').textContent = S.users.length;
  for (const u of S.users) {
    const r = el('div', 'member'); r.dataset.uid = u.id;
    const av = el('div', 'avatar'); paintAvatar(av, u);
    const info = el('div');
    info.append(el('div', null, u.name + (u.id === S.me?.id ? ' (você)' : '')));
    if (u.voice) { const ch = S.channels.find((c) => c.id === u.voice); info.append(el('div', 'muted small', '🔊 ' + (ch ? ch.name : 'voz'))); }
    r.append(av, info);
    list.append(r);
  }
  paintSpeaking();
}

function paintAvatar(node, u) {
  node.textContent = (u.name || '?').trim().charAt(0).toUpperCase();
  node.style.background = u.color || '#d8b45f';
}

// ================================================================ texto
function openText(id) {
  S.current = id; S.view = 'text'; S.unread.delete(id); LS.set('lastChannel', id);
  const ch = S.channels.find((c) => c.id === id);
  $('#chanTitle').textContent = '# ' + (ch ? ch.name : '');
  $('#chanSub').textContent = '';
  $('#textView').classList.remove('hidden'); $('#voiceView').classList.add('hidden');
  renderChannels();
  if (S.loaded.has(id)) renderMessages(true); else { $('#messages').replaceChildren(); send({ t: 'history', channel: id }); }
  renderTyping();
  $('#msgInput').focus();
}

let lastRendered = null;
function renderMessages() {
  const box = $('#messages'); box.replaceChildren(); lastRendered = null;
  for (const m of S.messages[S.current] || []) appendMessage(m, true);
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m, bulk) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const d = new Date(m.ts);
  const day = d.toDateString();
  if (!lastRendered || new Date(lastRendered.ts).toDateString() !== day) {
    const sep = el('div', 'day'); sep.append(el('span', null, d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })));
    box.append(sep); lastRendered = null;
  }
  const grouped = lastRendered && lastRendered.authorId === m.authorId && lastRendered.author === m.author && m.ts - lastRendered.ts < 5 * 60e3;
  const row = el('div', 'msg' + (grouped ? '' : ' first'));
  const left = el('div');
  const body = el('div');
  if (!grouped) {
    const av = el('div', 'avatar'); paintAvatar(av, { name: m.author, color: m.color }); left.append(av);
    const meta = el('div', 'meta');
    const b = el('b', null, m.author); b.style.color = m.color;
    meta.append(b, el('span', 'time', d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })));
    body.append(meta);
  } else {
    left.className = 'time'; left.style.cssText = 'text-align:center;padding-top:4px;visibility:hidden';
    left.textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    row.onmouseenter = () => (left.style.visibility = 'visible'); row.onmouseleave = () => (left.style.visibility = 'hidden');
  }
  if (m.text) { const t = el('div', 'text'); linkify(t, m.text); body.append(t); }
  for (const a of m.attachments || []) if (a && a.mime) body.append(renderAttachment(a));
  row.append(left, body);
  box.append(row);
  lastRendered = m;
  if (!bulk && (nearBottom || m.authorId === S.me.id)) box.scrollTop = box.scrollHeight;
  // imagens carregam depois e mudam a altura
  if (!bulk) row.querySelectorAll('img').forEach((i) => (i.onload = () => { if (nearBottom) box.scrollTop = box.scrollHeight; }));
}

function linkify(node, text) {
  const re = /(https?:\/\/[^\s<]+)/g; let last = 0, mm;
  while ((mm = re.exec(text))) {
    node.append(text.slice(last, mm.index));
    const a = el('a', null, mm[1]); a.href = mm[1]; a.target = '_blank'; a.rel = 'noreferrer';
    node.append(a); last = mm.index + mm[1].length;
  }
  node.append(text.slice(last));
}

const fileUrl = (id, download) => `${S.base}/files/${id}?t=${S.token}${download ? '&download=1' : ''}`;
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB'; }

function renderAttachment(a) {
  const w = el('div', 'att');
  if (a.mime.startsWith('image/')) {
    const img = el('img'); img.src = fileUrl(a.id); img.alt = a.name; img.loading = 'lazy';
    img.onclick = () => { const lb = el('div', 'lightbox'); const i = el('img'); i.src = img.src; lb.append(i); lb.onclick = () => lb.remove(); document.body.append(lb); };
    w.append(img);
  } else if (a.mime.startsWith('video/')) {
    const v = el('video'); v.src = fileUrl(a.id); v.controls = true; v.preload = 'metadata'; w.append(v);
  } else if (a.mime.startsWith('audio/')) {
    const au = el('audio'); au.src = fileUrl(a.id); au.controls = true; au.preload = 'none'; w.append(au);
  }
  const card = el('div', 'filecard');
  const link = el('a', null, a.name); link.href = fileUrl(a.id, true);
  const info = el('div'); info.append(link, el('div', 'muted small', fmtSize(a.size)));
  card.append(el('span', 'ico', iconFor(a.mime, a.name)), info);
  if (!/^(image|video)\//.test(a.mime)) w.append(card);
  else { const dl = el('a', 'small', 'baixar ' + a.name + ' (' + fmtSize(a.size) + ')'); dl.href = link.href; const d = el('div'); d.append(dl); w.append(d); }
  return w;
}
function iconFor(mime, name) {
  if (mime.startsWith('audio/')) return '🎵';
  if (/zip|rar|7z|tar|gzip/.test(mime) || /\.(zip|rar|7z)$/i.test(name)) return '🗜️';
  if (/pdf/.test(mime)) return '📕';
  if (/\.(exe|msi|apk)$/i.test(name)) return '⚙️';
  if (mime.startsWith('text/')) return '📝';
  return '📄';
}

// composer
const input = $('#msgInput');
let typingSent = 0;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  if (Date.now() - typingSent > 2500) { typingSent = Date.now(); send({ t: 'typing', channel: S.current }); }
});
function submitText() {
  const text = input.value;
  if (!text.trim()) return;
  if (!S.connected || !send({ t: 'msg', channel: S.current, text })) return toast('Sem conexão: sua mensagem continua na caixa.');
  input.value = ''; input.style.height = 'auto'; typingSent = 0;
}
function renderTyping() {
  const now = Date.now();
  const t = S.typing[S.current] || {};
  const names = Object.values(t).filter((x) => x.until > now).map((x) => x.name);
  $('#typing').textContent = names.length ? (names.length === 1 ? `${names[0]} está digitando…` : `${names.join(', ')} estão digitando…`) : '';
}
setInterval(renderTyping, 1500);

// arquivos
$('#btnAttach').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { uploadAndSend([...e.target.files]); e.target.value = ''; };
const tv = $('#textView');
let dragDepth = 0;
tv.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#dropHint').classList.remove('hidden'); } });
tv.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
tv.addEventListener('dragover', (e) => e.preventDefault());
tv.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#dropHint').classList.add('hidden'); uploadAndSend([...e.dataTransfer.files]); });
// soltar um arquivo fora da área do chat não pode abrir o arquivo no lugar do app
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); uploadAndSend(files); }
});

function upload(file, kind = 'file', extra = '') {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${S.base}/api/upload?kind=${kind}${extra}`);
    xhr.setRequestHeader('x-token', S.token);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'colado.png'));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    const row = el('div', 'up'); const prog = el('progress'); prog.max = 1; prog.value = 0;
    row.append(el('span', null, '⬆️ ' + (file.name || 'arquivo')), prog, el('span', null, fmtSize(file.size)));
    if (kind === 'file') $('#uploads').append(row);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) prog.value = e.loaded / e.total; };
    xhr.onload = () => { row.remove(); let r = {}; try { r = JSON.parse(xhr.responseText); } catch { /* */ } xhr.status === 200 ? resolve(r) : reject(new Error(r.error || 'falha no envio')); };
    xhr.onerror = () => { row.remove(); reject(new Error('falha de rede no envio')); };
    xhr.send(file);
  });
}
async function apiEnvio(caminho, corpo) {
  const r = await fetch(`${S.base}/api/upload/${caminho}`, { method: 'POST', headers: { 'x-token': S.token, 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'falha no envio');
  return j;
}

function enviarParte(url, parte, inicio, total, progresso) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Range', `bytes ${inicio}-${inicio + parte.size - 1}/${total}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progresso(inicio + e.loaded); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('o OneDrive recusou o envio')));
    xhr.onerror = () => reject(new Error('falha de rede no envio'));
    xhr.send(parte);
  });
}

// Com OneDrive ligado o arquivo vai direto para lá, em partes; sem ele, para o servidor
async function enviarArquivo(file) {
  const nome = file.name || 'colado.png';
  const envio = await apiEnvio('iniciar', { name: nome, size: file.size, mime: file.type });
  if (envio.local) return upload(file);
  const row = el('div', 'up'); const prog = el('progress'); prog.max = 1; prog.value = 0;
  row.append(el('span', null, '⬆️ ' + nome), prog, el('span', null, fmtSize(file.size)));
  $('#uploads').append(row);
  try {
    const PARTE = 32 * 327680;   // 10 MiB: o OneDrive exige múltiplos de 320 KiB
    for (let inicio = 0; inicio < file.size; inicio += PARTE) {
      const parte = file.slice(inicio, Math.min(inicio + PARTE, file.size));
      for (let tentativa = 1; ; tentativa++) {
        try { await enviarParte(envio.uploadUrl, parte, inicio, file.size, (n) => (prog.value = n / file.size)); break; }
        catch (e) { if (tentativa === 3) throw e; await new Promise((r) => setTimeout(r, 2000 * tentativa)); }
      }
    }
    return await apiEnvio('concluir', { id: envio.id });
  } finally { row.remove(); }
}

async function uploadAndSend(files) {
  if (!files.length || !S.current) return;
  const channel = S.current;
  const text = input.value; input.value = '';
  try {
    const atts = await Promise.all(files.map(enviarArquivo));
    if (!S.connected || !send({ t: 'msg', channel, text, attachments: atts.map((a) => ({ id: a.id })) })) throw new Error('sem conexão com o servidor');
  } catch (err) { toast('Erro ao enviar: ' + err.message); if (text) input.value = text; }
}

// ================================================================ áudio local
function ctx() {
  if (!S.audioCtx) S.audioCtx = new AudioContext();
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
  return S.audioCtx;
}

async function getMic() {
  const constraints = {
    audio: {
      deviceId: S.inputId ? { exact: S.inputId } : undefined,
      echoCancellation: true, noiseSuppression: LS.get('noise', true), autoGainControl: true,
    },
  };
  try { return await navigator.mediaDevices.getUserMedia(constraints); }
  catch (e) {
    if (S.inputId) { S.inputId = ''; return getMic(); }
    toast('Sem microfone — você vai entrar só ouvindo.'); return null;
  }
}

// detector de fala: chama cb(true/false) quando muda
function watchLevel(stream, cb) {
  const ac = ctx();
  const src = ac.createMediaStreamSource(stream);
  const an = ac.createAnalyser(); an.fftSize = 512;
  src.connect(an);
  const data = new Uint8Array(an.fftSize);
  let speaking = false, quietSince = 0;
  const timer = setInterval(() => {
    an.getByteTimeDomainData(data);
    let sum = 0; for (const v of data) sum += (v - 128) ** 2;
    const rms = Math.sqrt(sum / data.length);
    const now = Date.now();
    if (rms > 4) { quietSince = now; if (!speaking) { speaking = true; cb(true, rms); } }
    else if (speaking && now - quietSince > 300) { speaking = false; cb(false, rms); }
    if (cb.level) cb.level(rms);
  }, 60);
  return () => { clearInterval(timer); try { src.disconnect(); } catch { /* */ } };
}

// as listas são recriadas a cada atualização, então o estado fica guardado e é reaplicado
function paintSpeaking() {
  for (const id of S.speaking) document.querySelectorAll(`[data-uid="${id}"]`).forEach((n) => n.classList.add('speaking'));
}
function setSpeaking(uid, on) {
  if (on) S.speaking.add(uid); else S.speaking.delete(uid);
  document.querySelectorAll(`[data-uid="${uid}"]`).forEach((n) => n.classList.toggle('speaking', on));
}

// sons curtos de entrar/sair/mensagem
function playTone(kind) {
  if (S.deafened) return;
  const ac = ctx(); const o = ac.createOscillator(); const g = ac.createGain();
  const f = { join: [520, 780], leave: [700, 420], msg: [880, 880] }[kind];
  o.frequency.setValueAtTime(f[0], ac.currentTime); o.frequency.linearRampToValueAtTime(f[1], ac.currentTime + 0.12);
  g.gain.setValueAtTime(kind === 'msg' ? 0.04 : 0.08, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
  o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.26);
}

// ================================================================ voz (WebRTC em malha: cada um conecta com cada um)
async function joinVoice(id) {
  if (S.voice === id) return showVoiceView();
  ctx();
  if (S.voice) teardownVoice();   // trocando de sala
  if (!S.mic) {
    S.mic = await getMic();
    if (S.mic) {
      S.mic.getAudioTracks().forEach((t) => (t.enabled = !S.muted && !S.deafened));
      S.stopMicMeter = watchLevel(S.mic, (on) => setSpeaking(S.me.id, on && !S.muted && !S.deafened));
    }
  }
  send({ t: 'voice_join', channel: id });
}

function startVoice(channel, peers) {
  S.voice = channel;
  $('#voicePanel').classList.remove('hidden');
  const ch = S.channels.find((c) => c.id === channel);
  $('#vpChannel').textContent = ch ? ch.name : '';
  playTone('join');
  for (const pid of peers) ensurePeer(pid);   // quem entra inicia a conexão
  pushVoiceState();
  showVoiceView();
}

function showVoiceView() {
  S.view = 'voice';
  $('#textView').classList.add('hidden'); $('#voiceView').classList.remove('hidden');
  renderChannels(); renderVoiceView();
}

function ensurePeer(pid) {
  let p = S.peers.get(pid);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  p = { id: pid, pc, polite: S.me.id > pid, makingOffer: false, ignoreOffer: false, audios: new Map(), stopMeter: null, screenSenders: [] };
  S.peers.set(pid, p);

  // sempre negocia uma faixa de áudio (mesmo sem microfone, para conseguir ouvir)
  const micTrack = S.mic && S.mic.getAudioTracks()[0];
  if (micTrack) pc.addTrack(micTrack, S.mic);
  else pc.addTransceiver('audio', { direction: 'recvonly' });
  if (S.screen) addScreenTo(p);

  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      send({ t: 'signal', to: pid, data: { description: pc.localDescription } });
    } catch (e) { console.warn('negociação', e); }
    finally { p.makingOffer = false; }
  };
  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ t: 'signal', to: pid, data: { candidate } }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce();
  };
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] || new MediaStream([track]);
    if (track.kind === 'audio') {
      if (p.audios.has(stream.id)) return;
      const a = new Audio(); a.autoplay = true; a.srcObject = stream;
      applyVolume(p, a);
      if (S.outputId && a.setSinkId) a.setSinkId(S.outputId).catch(() => {});
      p.audios.set(stream.id, a);
      a.play().catch(() => {});
      // primeiro áudio = microfone → indicador de fala
      if (!p.stopMeter) p.stopMeter = watchLevel(stream, (on) => setSpeaking(pid, on));
      stream.addEventListener('removetrack', () => { if (!stream.getTracks().length) { a.srcObject = null; p.audios.delete(stream.id); } });
    } else {
      addScreenTile(pid, stream);
      stream.addEventListener('removetrack', () => { if (!stream.getVideoTracks().length) removeScreenTile(pid); });
    }
  };
  return p;
}

async function onSignal(from, data) {
  if (!S.voice) return;
  const p = ensurePeer(from);
  const pc = p.pc;
  try {
    if (data.description) {
      const d = data.description;
      const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        send({ t: 'signal', to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) console.warn(e); }
    }
  } catch (e) { console.warn('sinalização', e); }
}

function closePeer(pid) {
  const p = S.peers.get(pid);
  if (!p) return;
  S.peers.delete(pid);
  if (p.stopMeter) p.stopMeter();
  for (const a of p.audios.values()) { a.srcObject = null; }
  try { p.pc.close(); } catch { /* */ }
  removeScreenTile(pid);
  setSpeaking(pid, false);
}

function teardownVoice() {
  for (const id of [...S.peers.keys()]) closePeer(id);
  if (S.screen) stopScreen(true);
  if (S.voice) playTone('leave');
  S.voice = null;
  S.speaking.clear();
  $('#voicePanel').classList.add('hidden');
  $('#soundboard').classList.add('hidden');
  $('#stage').replaceChildren();
  if (S.mic) { if (S.stopMicMeter) S.stopMicMeter(); S.mic.getTracks().forEach((t) => t.stop()); S.mic = null; }
  if (S.view === 'voice' && S.current) openText(S.current);
  renderChannels();
}

function pushVoiceState() { send({ t: 'voice_state', muted: S.muted, deafened: S.deafened, sharing: !!S.screen }); }

function applyVolume(p, a) {
  const v = S.userVol[nameOf(p.id)] ?? 1;
  a.volume = Math.min(1, v);
  a.muted = S.deafened;
}
function nameOf(id) { const u = S.users.find((x) => x.id === id); return u ? u.name : id; }

function renderVoiceView() {
  if (!S.voice) { $('#tiles').replaceChildren(); return; }
  const ch = S.channels.find((c) => c.id === S.voice);
  if (S.view === 'voice') { $('#chanTitle').textContent = '🔊 ' + (ch ? ch.name : ''); $('#chanSub').textContent = 'canal de voz'; }
  const tiles = $('#tiles'); tiles.replaceChildren();
  const members = S.users.filter((u) => u.voice === S.voice);
  for (const u of members) {
    const t = el('div', 'tile'); t.dataset.uid = u.id;
    const av = el('div', 'avatar'); paintAvatar(av, u);
    t.append(av, el('div', null, u.name + (u.id === S.me.id ? ' (você)' : '')));
    const flags = el('div', 'flags');
    if (u.sharing) flags.append(el('span', 'live', 'AO VIVO'));
    if (u.deafened) flags.append(' 🙉'); else if (u.muted) flags.append(' 🔇');
    t.append(flags);
    if (u.id !== S.me.id) {
      const vol = el('input', 'vol'); vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.05;
      vol.value = S.userVol[u.name] ?? 1; vol.title = 'Volume de ' + u.name;
      vol.oninput = () => {
        S.userVol[u.name] = Number(vol.value); LS.set('userVol', S.userVol);
        const p = S.peers.get(u.id); if (p) for (const a of p.audios.values()) applyVolume(p, a);
      };
      t.append(vol);
    }
    tiles.append(t);
  }
  $('#voiceHint').textContent = members.length <= 1 ? 'Ninguém mais por aqui ainda. Chama a galera! 📣' : '';
  paintSpeaking();
}

// ================================================================ mute / deafen
function refreshButtons() {
  $('#btnMute').classList.toggle('off', S.muted || S.deafened);
  $('#btnDeafen').classList.toggle('off', S.deafened);
  $('#btnMute').title = S.muted ? 'Desmutar' : 'Mutar microfone';
  $('#btnDeafen').title = S.deafened ? 'Voltar a ouvir' : 'Ensurdecer';
  if (S.mic) S.mic.getAudioTracks().forEach((t) => (t.enabled = !S.muted && !S.deafened));
  for (const p of S.peers.values()) for (const a of p.audios.values()) applyVolume(p, a);
  if (S.muted || S.deafened) setSpeaking(S.me?.id, false);
}
$('#btnMute').onclick = () => { if (S.deafened) { S.deafened = false; S.muted = false; } else S.muted = !S.muted; LS.set('muted', S.muted); refreshButtons(); pushVoiceState(); };
$('#btnDeafen').onclick = () => { S.deafened = !S.deafened; refreshButtons(); pushVoiceState(); };
$('#btnLeave').onclick = () => send({ t: 'voice_leave' });
refreshButtons();

// ================================================================ compartilhar tela
$('#btnScreen').onclick = () => (S.screen ? stopScreen() : startScreen());

async function startScreen() {
  const q = LS.get('screenQuality', '1080p30');
  const [h, fps, kbps] = { '720p30': [720, 30, 2500], '1080p30': [1080, 30, 4000], '1080p60': [1080, 60, 8000] }[q] || [1080, 30, 4000];
  S.screenBitrate = kbps * 1000;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { height: { ideal: h }, frameRate: { ideal: fps } },
      audio: true,
    });
  } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Não deu para compartilhar: ' + e.message); return; }
  const v = stream.getVideoTracks()[0];
  if (v) { v.contentHint = 'motion'; v.onended = () => stopScreen(); }
  S.screen = stream;
  for (const p of S.peers.values()) addScreenTo(p);
  addScreenTile(S.me.id, stream, true);
  $('#btnScreen').classList.add('on'); $('#btnScreen').textContent = '⏹ Parar';
  pushVoiceState();
}

function addScreenTo(p) {
  for (const track of S.screen.getTracks()) {
    const sender = p.pc.addTrack(track, S.screen);
    p.screenSenders.push(sender);
    if (track.kind === 'video') {
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = S.screenBitrate;
      sender.setParameters(params).catch(() => {});
    }
  }
}

function stopScreen(silent) {
  if (!S.screen) return;
  S.screen.getTracks().forEach((t) => t.stop());
  for (const p of S.peers.values()) {
    for (const s of p.screenSenders) { try { p.pc.removeTrack(s); } catch { /* */ } }
    p.screenSenders = [];
  }
  S.screen = null;
  removeScreenTile(S.me.id);
  $('#btnScreen').classList.remove('on'); $('#btnScreen').textContent = '🖥️ Tela';
  if (!silent) pushVoiceState();
}

function addScreenTile(uid, stream, local) {
  let t = document.querySelector(`.screen-tile[data-screen="${uid}"]`);
  if (!t) {
    t = el('div', 'screen-tile'); t.dataset.screen = uid;
    const v = el('video'); v.autoplay = true; v.playsInline = true; v.muted = true;
    const label = el('div', 'label', '🖥️ ' + (local ? 'Sua tela' : nameOf(uid)));
    const tools = el('div', 'tools');
    const focus = el('button', null, '⤢'); focus.title = 'Focar';
    focus.onclick = () => {
      const st = $('#stage'); const on = !t.classList.contains('focused');
      st.querySelectorAll('.screen-tile').forEach((x) => x.classList.remove('focused'));
      t.classList.toggle('focused', on); st.classList.toggle('focus', on);
    };
    const fs = el('button', null, '⛶'); fs.title = 'Tela cheia'; fs.onclick = () => t.requestFullscreen();
    tools.append(focus, fs); t.append(v, label, tools);
    t.ondblclick = () => (document.fullscreenElement ? document.exitFullscreen() : t.requestFullscreen());
    $('#stage').append(t);
  }
  const v = t.querySelector('video');
  if (v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
}
function removeScreenTile(uid) {
  const t = document.querySelector(`.screen-tile[data-screen="${uid}"]`);
  if (t) { const st = $('#stage'); if (t.classList.contains('focused')) st.classList.remove('focus'); t.remove(); }
}

// Electron: seletor de tela/janela
if (window.djachatDesktop) {
  window.djachatDesktop.onPickSource((sources) => {
    let chosen = null;
    const grid = el('div', 'sources');
    for (const s of sources) {
      const b = el('div', 'source');
      const img = el('img'); img.src = s.thumbnail;
      b.append(img, el('div', null, s.name));
      b.onclick = () => { grid.querySelectorAll('.source').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); chosen = s.id; };
      b.ondblclick = () => { chosen = s.id; $('#modalOk').click(); };
      grid.append(b);
    }
    const body = el('div');
    const audioRow = el('div', 'row');
    const chk = el('input'); chk.type = 'checkbox'; chk.id = 'shareAudio'; chk.checked = LS.get('shareSystemAudio', false); chk.style.width = 'auto';
    const lab = el('label', null, 'Compartilhar o som do PC (Windows). Quem está na chamada pode ouvir o próprio eco.'); lab.htmlFor = 'shareAudio';
    audioRow.append(chk, lab);
    body.append(el('div', 'muted small', 'Escolha uma tela ou janela:'), grid, audioRow);
    openModal('Compartilhar tela', body, 'Compartilhar', () => {
      LS.set('shareSystemAudio', chk.checked);
      window.djachatDesktop.pickSource(chosen, chk.checked);
    }, () => window.djachatDesktop.pickSource(null, false));
  });
}

// ================================================================ soundboard
$('#btnSoundboard').onclick = (e) => { e.stopPropagation(); $('#soundboard').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!e.target.closest('#soundboard') && !e.target.closest('#modal')) $('#soundboard').classList.add('hidden'); });
$('#sbVolume').value = S.sbVolume;
$('#sbVolume').oninput = (e) => { S.sbVolume = Number(e.target.value); LS.set('sbVolume', S.sbVolume); };
$('#sbUpload').onclick = () => $('#sbFile').click();
$('#sbFile').onchange = (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 3 * 1024 * 1024) return toast('Som grande demais (máx. 3 MB)');
  promptModal('Emoji do som', 'Um emoji para o botão', '🔊', async (emoji) => {
    try { await upload(f, 'sound', '&emoji=' + encodeURIComponent(emoji || '🔊')); toast('Som adicionado!'); }
    catch (err) { toast('Erro: ' + err.message); }
  });
};

function renderSounds() {
  const g = $('#sbGrid'); g.replaceChildren();
  if (!S.sounds.length) g.append(el('div', 'muted small', 'Nenhum som ainda. Adicione o primeiro!'));
  for (const s of S.sounds) {
    const b = el('button', 'sound'); b.dataset.sound = s.id; b.title = s.name;
    b.append(el('span', 'em', s.emoji || '🔊'), s.name);
    const x = el('button', 'x', '✕'); x.title = 'Remover som';
    x.onclick = (e) => { e.stopPropagation(); confirmModal('Remover som?', `"${s.name}" sai do soundboard de todo mundo.`, () => send({ t: 'sound_delete', id: s.id })); };
    b.append(x);
    b.onclick = () => { if (!S.voice) return toast('Entre num canal de voz para tocar sons'); send({ t: 'sound_play', id: s.id }); };
    g.append(b);
  }
}

const soundCache = new Map();
function playSound(id) {
  const s = S.sounds.find((x) => x.id === id);
  if (!s || S.deafened) return;
  let a = soundCache.get(s.fileId);
  if (!a) { a = new Audio(fileUrl(s.fileId)); soundCache.set(s.fileId, a); }
  const node = a.cloneNode(); node.volume = S.sbVolume;
  if (S.outputId && node.setSinkId) node.setSinkId(S.outputId).catch(() => {});
  node.play().catch(() => {});
  const btn = document.querySelector(`.sound[data-sound="${id}"]`);
  if (btn) { btn.classList.add('playing'); node.onended = () => btn.classList.remove('playing'); }
}

// ================================================================ configurações
$('#btnSettings').onclick = async () => {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* */ }
  const body = el('div');
  const mkSelect = (label, kind, current) => {
    const l = el('label', null, label); const s = el('select');
    s.append(new Option('Padrão do sistema', ''));
    for (const d of devices.filter((x) => x.kind === kind)) s.append(new Option(d.label || d.kind, d.deviceId));
    s.value = current; l.append(s); body.append(l); return s;
  };
  const inSel = mkSelect('Microfone', 'audioinput', S.inputId);
  const meter = el('div', 'meter'); const bar = el('div'); meter.append(bar); body.append(meter);
  const outSel = mkSelect('Saída de áudio', 'audiooutput', S.outputId);
  const noiseRow = el('div', 'row');
  const noise = el('input'); noise.type = 'checkbox'; noise.id = 'noiseChk'; noise.checked = LS.get('noise', true); noise.style.width = 'auto';
  const nl = el('label', null, 'Supressão de ruído'); nl.htmlFor = 'noiseChk'; noiseRow.append(noise, nl); body.append(noiseRow);
  const ql = el('label', null, 'Qualidade do compartilhamento de tela'); const qs = el('select');
  for (const [v, t] of [['720p30', '720p 30fps (internet fraca)'], ['1080p30', '1080p 30fps'], ['1080p60', '1080p 60fps (jogos)']]) qs.append(new Option(t, v));
  qs.value = LS.get('screenQuality', '1080p30'); ql.append(qs); body.append(ql);
  const out = el('button', null, 'Sair da conta'); out.style.marginTop = '18px';
  out.onclick = () => { $('#modal').classList.add('hidden'); cleanup(); S.wantVoice = null; LS.set('session', ''); if (S.voice) { send({ t: 'voice_leave' }); teardownVoice(); } const w = S.ws; S.me = null; S.ws = null; w && w.close(); showLogin(); };
  body.append(out);

  // medidor do microfone escolhido
  let testStream = null, stopTest = null;
  const startTest = async () => {
    if (stopTest) stopTest(); if (testStream) testStream.getTracks().forEach((t) => t.stop());
    try { testStream = await navigator.mediaDevices.getUserMedia({ audio: inSel.value ? { deviceId: { exact: inSel.value } } : true }); }
    catch { return; }
    const cb = () => {}; cb.level = (rms) => (bar.style.width = Math.min(100, rms * 4) + '%');
    stopTest = watchLevel(testStream, cb);
  };
  inSel.onchange = startTest; startTest();
  const cleanup = () => { if (stopTest) stopTest(); if (testStream) testStream.getTracks().forEach((t) => t.stop()); };

  openModal('Configurações', body, 'Salvar', async () => {
    cleanup();
    const micChanged = inSel.value !== S.inputId || noise.checked !== LS.get('noise', true);
    S.inputId = inSel.value; S.outputId = outSel.value;
    LS.set('inputId', S.inputId); LS.set('outputId', S.outputId); LS.set('noise', noise.checked); LS.set('screenQuality', qs.value);
    for (const p of S.peers.values()) for (const a of p.audios.values()) if (a.setSinkId) a.setSinkId(S.outputId).catch(() => {});
    if (micChanged && S.mic) await swapMic();
  }, cleanup);
};

async function swapMic() {
  const fresh = await getMic();
  if (!fresh) return;
  const track = fresh.getAudioTracks()[0];
  for (const p of S.peers.values()) {
    const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === 'audio' && !p.screenSenders.includes(s));
    if (sender) await sender.replaceTrack(track);
  }
  if (S.stopMicMeter) S.stopMicMeter();
  S.mic.getTracks().forEach((t) => t.stop());
  S.mic = fresh;
  S.stopMicMeter = watchLevel(S.mic, (on) => setSpeaking(S.me.id, on && !S.muted && !S.deafened));
  refreshButtons();
}

// ================================================================ modal / toast
let modalOk = null, modalCancel = null;
function openModal(title, bodyNode, okText, onOk, onCancel) {
  $('#modalTitle').textContent = title;
  $('#modalBody').replaceChildren(bodyNode);
  $('#modalOk').textContent = okText || 'OK';
  modalOk = onOk; modalCancel = onCancel;
  $('#modal').classList.remove('hidden');
  const f = bodyNode.querySelector && bodyNode.querySelector('input:not([type=checkbox])'); if (f) setTimeout(() => f.focus(), 30);
}
function closeModal() { $('#modal').classList.add('hidden'); modalOk = modalCancel = null; }
$('#modalOk').onclick = () => { const f = modalOk; modalCancel = null; closeModal(); if (f) f(); };
$('#modalCancel').onclick = () => { const f = modalCancel; closeModal(); if (f) f(); };
$('#modal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('#modalOk').click();
  if (e.key === 'Escape') $('#modalCancel').click();
});
function promptModal(title, label, value, cb) {
  const l = el('label', null, label); const i = el('input'); i.value = value; l.append(i);
  openModal(title, l, 'OK', () => { const v = i.value.trim(); if (v) cb(v); });
}
function confirmModal(title, text, cb) { openModal(title, el('p', 'muted', text), 'Confirmar', cb); }

let toastTimer;
function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ================================================================ início
window.addEventListener('beforeunload', () => { if (S.voice) send({ t: 'voice_leave' }); });
showLogin();
if (LS.get('name') && LS.get('server') && LS.get('session')) $('#loginForm').requestSubmit();
