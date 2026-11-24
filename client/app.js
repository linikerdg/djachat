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
  mencoes: {},             // channelId -> quantas menções a mim ainda não vistas
  mais: {},                // channelId -> true se há mensagens mais antigas no servidor
  lidas: LS.get('lidas', {}),   // channelId -> ts da última mensagem que eu vi
  lidaAoAbrir: null,          // até onde eu tinha lido quando abri o canal atual (linha "novas mensagens")
  typing: {},              // channelId -> { id: {name, until} }
  voice: null,             // id do canal de voz em que estou
  muted: LS.get('muted', false), deafened: false,
  mic: null,               // MediaStream do microfone (já processado)
  micRaw: null,
  screen: null,            // MediaStream da tela
  assistindo: new Set(),   // ids de quem eu pedi para assistir a tela
  dms: [],                 // conversas diretas: { id, outro, name }
  respondendo: null,       // { id, author, text } da mensagem que estou respondendo
  silenciados: new Set(LS.get('silenciados', [])),   // canais sem som de mensagem nova
  volumes: LS.get('volumes', {}),     // chavePessoa -> 0..2 (voz)
  volTela: LS.get('volTela', {}),     // chavePessoa -> 0..2 (som da tela compartilhada)
  mutados: new Set(LS.get('mutados', [])),   // pessoas que eu mutei só para mim
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
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: LS.get('name', ''), password: S.pass, session: LS.get('session', ''), chave: chaveConta() }));
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false;
    informarEstado();
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

// Conta leve: um código secreto deste PC. Quem tem o código é dono do apelido e das próprias mensagens.
function chaveConta() {
  let k = LS.get('chave', '');
  if (!/^[a-f0-9]{64}$/.test(k)) {
    k = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    LS.set('chave', k);
  }
  return k;
}
const souEu = (msg) => (msg.uid && S.me.uid ? msg.uid === S.me.uid : msg.authorId === S.me.id);
const idDm = (uidOutro) => 'dm:' + [S.me.uid, uidOutro].sort().join(':');
const canalInfo = (id) => S.channels.find((c) => c.id === id) || S.dms.find((d) => d.id === id);
// chave estável de cada pessoa para guardar volume e mudo (conta; app antigo cai no nome)
const chavePessoa = (u) => (u.uid ? u.uid : 'nome:' + u.name);

function handle(m) {
  switch (m.t) {
    case 'error':
      if (m.code === 'senha' || m.code === 'apelido') {
        S.me = null; S.pass = '';
        if (m.code === 'senha') LS.set('session', '');
        const w = S.ws; S.ws = null; w.close(); showLogin(); $('#lError').textContent = m.message;
      } else toast(m.message);
      break;
    case 'aviso': toast(m.message); break;
    case 'codigo_hospedagem': copiarTexto(m.codigo, 'Código copiado. No outro PC, abra o conectar-onedrive.bat e cole.'); break;
    case 'mover': toast(`${m.por} moveu você de sala.`); joinVoice(m.channel); break;
    case 'dms': {
      // a lista do servidor vale; conversas abertas aqui e ainda sem mensagem continuam
      const locais = S.dms.filter((d) => !m.dms.some((x) => x.id === d.id) && d.id === S.current);
      S.dms = [...m.dms, ...locais];
      renderChannels();
      break;
    }
    case 'msg_update': {
      const lista = S.messages[m.message.channel];
      const i = lista ? lista.findIndex((x) => x.id === m.message.id) : -1;
      if (i >= 0) lista[i] = m.message;
      if (m.message.channel === S.current && S.view === 'text') atualizarLinha(m.message);
      break;
    }
    case 'msg_delete': {
      const lista = S.messages[m.channel];
      if (lista) S.messages[m.channel] = lista.filter((x) => x.id !== m.id);
      if (S.respondendo && S.respondendo.id === m.id) cancelarResposta();
      if (m.channel === S.current && S.view === 'text') renderMessages(true);
      break;
    }
    case 'welcome': {
      S.connected = true; S.me = m.you; S.token = m.token;
      S.pass = ''; LS.set('session', m.session);
      soundCache.clear();   // os endereços dos sons levam o servidor e o token: trocando de servidor, mudam
      if (m.ice) S.ice = m.ice;
      S.channels = m.channels; S.sounds = m.sounds; S.users = m.users; S.dms = m.dms || []; S.hospedavel = !!m.hospedavel;
      $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
      $('#connDot').className = 'dot ok'; $('#connDot').title = 'Conectado';
      $('#meName').textContent = S.me.name; paintAvatar($('#meAvatar'), S.me);
      S.messages = {}; S.loaded = new Set(); S.mais = {};
      marcarNaoLidas(m.ultimas || {});
      const first = canalInfo(LS.get('lastChannel')) || S.channels.find((c) => c.kind === 'text');
      if (first) openText(first.id);
      renderChannels(); renderMembers(); renderSounds();
      if (S.wantVoice) { const v = S.wantVoice; S.wantVoice = null; joinVoice(v); }
      break;
    }
    case 'channels':
      S.channels = m.channels;
      if (S.current && !canalInfo(S.current)) {
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
      if (m.antes) {
        // página de mensagens antigas: entra no começo, sem mexer na posição de leitura
        S.carregandoAntigas = false;
        const atual = S.messages[m.channel] || [];
        if (!atual.length || atual[0].id !== m.antes) break;   // a lista mudou nesse meio-tempo
        S.messages[m.channel] = m.messages.concat(atual);
        S.mais[m.channel] = !!m.mais;
        if (m.channel === S.current && S.view === 'text') renderMessages('topo');
        break;
      }
      S.messages[m.channel] = m.messages;
      S.mais[m.channel] = !!m.mais;
      S.loaded.add(m.channel);
      if (m.channel === S.current) { renderMessages(); marcarLido(m.channel); }
      break;
    case 'msg': {
      const msg = m.message;
      (S.messages[msg.channel] ||= []).push(msg);
      if (S.typing[msg.channel]) delete S.typing[msg.channel][msg.authorId];
      const vendo = msg.channel === S.current && S.view === 'text';
      const mencao = !souEu(msg) && mencionaNome(msg.text, S.me.name);
      if (vendo) { appendMessage(msg); if (document.hasFocus()) marcarLido(msg.channel); }
      if (!souEu(msg) && !vendo) {
        S.unread.add(msg.channel);
        if (mencao) S.mencoes[msg.channel] = (S.mencoes[msg.channel] || 0) + 1;
        renderChannels();
      }
      // menção toca mesmo em canal silenciado
      if (!souEu(msg) && (mencao || !S.silenciados.has(msg.channel)) && (!document.hasFocus() || msg.channel !== S.current)) {
        playTone(mencao ? 'mencao' : 'msg');
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
  const tc = $('#textChannels'), vc = $('#voiceChannels'), dl = $('#dmList');
  tc.replaceChildren(); vc.replaceChildren(); dl.replaceChildren();
  for (const d of S.dms) {
    const row = el('div', 'chan dm');
    const online = S.users.find((u) => u.uid === d.outro);
    const av = el('div', 'avatar'); paintAvatar(av, { name: d.name, color: online ? online.color : null });
    row.append(av, el('span', 'name', d.name));
    if (d.id === S.current && S.view === 'text') row.classList.add('active');
    if (S.unread.has(d.id)) row.classList.add('unread');
    seloMencoes(row, d.id);
    row.onclick = () => openText(d.id);
    row.oncontextmenu = (e) => menuCanal(e, d);
    dl.append(row);
  }
  $('#dmCat').classList.toggle('hidden', !S.dms.length);
  informarEstado();
  for (const ch of S.channels) {
    const row = el('div', 'chan');
    row.oncontextmenu = (e) => menuCanal(e, ch);
    const tipo = el('span', 'hash'); tipo.append(ic(ch.kind === 'text' ? 'hash' : 'volume-2'));
    row.append(tipo, el('span', 'name', ch.name));
    const del = el('button', 'del'); del.append(ic('x')); del.title = 'Apagar canal';
    del.onclick = (e) => { e.stopPropagation(); confirmModal(`Apagar "${ch.name}"?`, 'As mensagens do canal serão perdidas.', () => send({ t: 'channel_delete', id: ch.id })); };
    row.append(del);
    if (ch.kind === 'text') {
      if (ch.id === S.current && S.view === 'text') row.classList.add('active');
      if (S.unread.has(ch.id)) row.classList.add('unread');
      seloMencoes(row, ch.id);
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
          r.oncontextmenu = (e) => menuPessoa(e, u);
          const av = el('div', 'avatar'); paintAvatar(av, u);
          r.append(av, el('span', null, u.name));
          const flags = el('span', 'flags');
          if (u.sharing) flags.append(seloAoVivo(u));
          if (u.deafened) flags.append(ic('headphone-off')); else if (u.muted) flags.append(ic('mic-off'));
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
    r.oncontextmenu = (e) => menuPessoa(e, u);
    const av = el('div', 'avatar'); paintAvatar(av, u);
    const info = el('div');
    info.append(el('div', null, u.name + (u.id === S.me?.id ? ' (você)' : '')));
    if (u.id !== S.me?.id && S.mutados.has(chavePessoa(u))) { const mu = ic('volume-x', 'mutado-por-mim'); mu.setAttribute('aria-label', 'mutado por você'); info.firstChild.append(' ', mu); }
    if (u.voice) { const ch = S.channels.find((c) => c.id === u.voice); const v = el('div', 'muted small na-voz'); v.append(ic('volume-2'), ch ? ch.name : 'voz'); info.append(v); }
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
  // linha "novas mensagens" só quando o canal tinha coisa não lida
  S.lidaAoAbrir = S.unread.has(id) ? (S.lidas[id] || 0) : null;
  S.current = id; S.view = 'text'; S.unread.delete(id); delete S.mencoes[id]; LS.set('lastChannel', id);
  const ch = canalInfo(id);
  $('#chanTitle').replaceChildren(ic(ch && ch.kind === 'dm' ? 'at-sign' : 'hash'), ch ? ch.name : '');
  $('#chanSub').textContent = ch && ch.kind === 'dm' ? 'mensagem direta' : '';
  $('#textView').classList.remove('hidden'); $('#voiceView').classList.add('hidden');
  if (S.respondendo && S.respondendo.canal !== id) cancelarResposta();
  renderChannels();
  renderAnexos();   // atualiza o texto de ajuda da caixa para este canal
  if (S.loaded.has(id)) { renderMessages(); marcarLido(id); } else { $('#messages').replaceChildren(); send({ t: 'history', channel: id }); }
  renderTyping();
  $('#msgInput').focus();
}

let lastRendered = null;
// manterPosicao: true = fica onde está; 'topo' = entraram mensagens antigas em cima (a mesma mensagem continua à vista)
function renderMessages(manterPosicao) {
  const box = $('#messages');
  const pos = box.scrollTop, doFim = box.scrollHeight - box.scrollTop;
  box.replaceChildren(); lastRendered = null;
  const lista = S.messages[S.current] || [];
  if (lista.length) box.append(el('div', 'inicio-canal muted small', S.mais[S.current] ? 'Role para cima para ver mensagens mais antigas' : 'Este é o começo da conversa.'));
  let novas = null;
  for (const m of lista) {
    if (!novas && S.lidaAoAbrir !== null && m.ts > S.lidaAoAbrir && !souEu(m)) {
      novas = el('div', 'novas'); novas.append(el('span', null, 'novas mensagens'));
      box.append(novas);
      // a primeira depois da linha mostra o autor de novo, sem repetir a data
      if (lastRendered) lastRendered = { ts: lastRendered.ts };
    }
    appendMessage(m, true);
  }
  if (manterPosicao === 'topo') box.scrollTop = box.scrollHeight - doFim;
  else if (manterPosicao) box.scrollTop = pos;
  else if (novas && novas.offsetTop > box.clientHeight) box.scrollTop = novas.offsetTop - 60;   // abre nas novas
  else box.scrollTop = box.scrollHeight;
}
// Rolou até o topo: pede a página anterior
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  const lista = S.messages[S.current];
  if (box.scrollTop > 150 || S.carregandoAntigas || !S.mais[S.current] || !lista || !lista.length) return;
  S.carregandoAntigas = true;
  send({ t: 'history', channel: S.current, antes: lista[0].id });
  setTimeout(() => { S.carregandoAntigas = false; }, 5000);   // sem resposta: deixa tentar de novo
});

// ---------------------------------------------------------------- lidas e menções
function marcarLido(canal) {
  const l = S.messages[canal];
  const ultima = l && l[l.length - 1];
  if (!ultima || (S.lidas[canal] || 0) >= ultima.ts) return;
  S.lidas[canal] = ultima.ts;
  LS.set('lidas', S.lidas);
}
// Ao entrar: o que chegou desde a última vez fica como não lido
function marcarNaoLidas(ultimas) {
  if (!Object.keys(S.lidas).length) {
    // primeira vez neste PC: tudo começa como lido
    for (const [id, u] of Object.entries(ultimas)) S.lidas[id] = u.ts;
    LS.set('lidas', S.lidas);
    return;
  }
  for (const [id, u] of Object.entries(ultimas)) {
    if (u.ts > (S.lidas[id] || 0) && u.uid !== S.me.uid) S.unread.add(id);
  }
}
window.addEventListener('focus', () => { if (S.current && S.view === 'text') marcarLido(S.current); });
function seloMencoes(row, id) {
  const n = S.mencoes[id];
  if (n) row.append(el('span', 'selo-mencao', n > 9 ? '9+' : String(n)));
}
// apelidos que o app conhece: quem está online, as conversas diretas e quem escreveu no canal aberto
function nomesConhecidos() {
  const nomes = new Set(S.users.map((u) => u.name));
  for (const d of S.dms) nomes.add(d.name);
  for (const m of S.messages[S.current] || []) nomes.add(m.author);
  return [...nomes];
}

const mesmoAutor = (a, b) => (a.uid || a.authorId) === (b.uid || b.authorId) && a.author === b.author;
function nomeDaConta(uidConta) {
  const u = S.users.find((x) => x.uid === uidConta) || S.dms.find((d) => d.outro === uidConta);
  return u ? u.name : 'alguém';
}

// Monta a linha de uma mensagem (usada ao listar e ao atualizar uma mensagem editada ou com reação)
function criarLinha(m, grouped) {
  const d = new Date(m.ts);
  const row = el('div', 'msg' + (grouped ? '' : ' first')); row.dataset.id = m.id;
  const left = el('div');
  const body = el('div', 'corpo');
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
  if (m.resposta) {
    const r = el('div', 'resposta'); r.title = 'Ir para a mensagem original';
    r.append(ic('reply'), el('b', null, m.resposta.author), el('span', null, m.resposta.text));
    r.onclick = () => irPara(m.resposta.id);
    body.append(r);
  }
  if (m.text) {
    const t = el('div', 'text'); formatar(t, m.text, { nomes: nomesConhecidos(), meuNome: S.me.name });
    if (!souEu(m) && mencionaNome(m.text, S.me.name)) row.classList.add('mencionado');
    if (m.editada) t.append(el('span', 'editada', ' (editada)'));
    body.append(t);
  }
  for (const a of m.attachments || []) if (a && a.mime) body.append(renderAttachment(a, m));
  const reacoes = Object.entries(m.reacoes || {});
  if (reacoes.length) {
    const rr = el('div', 'reacoes');
    for (const [emoji, quem] of reacoes) {
      const b = el('button', 'reacao' + (S.me.uid && quem.includes(S.me.uid) ? ' minha' : '')); b.type = 'button';
      b.append(el('span', null, emoji), el('span', 'n', String(quem.length)));
      b.title = quem.map(nomeDaConta).join(', ');
      b.onclick = () => reagir(m, emoji);
      rr.append(b);
    }
    body.append(rr);
  }
  row.append(left, body);
  row.oncontextmenu = (e) => menuMensagem(e, m);
  return row;
}
function atualizarLinha(m) {
  const row = $('#messages').querySelector(`.msg[data-id="${m.id}"]`);
  if (row) row.replaceWith(criarLinha(m, !row.classList.contains('first')));
}
function irPara(id) {
  const row = $('#messages').querySelector(`.msg[data-id="${id}"]`);
  if (!row) return toast('A mensagem original já não está carregada.');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('destaque'); setTimeout(() => row.classList.remove('destaque'), 1600);
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
  const grouped = lastRendered && mesmoAutor(lastRendered, m) && !m.resposta && m.ts - lastRendered.ts < 5 * 60e3;
  const row = criarLinha(m, grouped);
  box.append(row);
  lastRendered = m;
  if (!bulk && (nearBottom || souEu(m))) box.scrollTop = box.scrollHeight;
  // imagens carregam depois e mudam a altura
  if (!bulk) row.querySelectorAll('img').forEach((i) => (i.onload = () => { if (nearBottom) box.scrollTop = box.scrollHeight; }));
}

const fileUrl = (id, download) => `${S.base}/files/${id}?t=${S.token}${download ? '&download=1' : ''}`;
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB'; }

function renderAttachment(a, m) {
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
  w.oncontextmenu = (e) => menuAnexo(e, a, m);
  const card = el('div', 'filecard');
  // abre fora da página: navegar a própria janela tirava a pessoa da sala de voz
  const link = el('a', null, a.name); link.href = fileUrl(a.id, true); link.target = '_blank'; link.rel = 'noreferrer';
  const info = el('div'); info.append(link, el('div', 'muted small', fmtSize(a.size)));
  const ico = el('span', 'ico'); ico.append(ic(iconFor(a.mime, a.name)));
  card.append(ico, info);
  if (!/^(image|video)\//.test(a.mime)) w.append(card);
  else { const dl = el('a', 'small', 'baixar ' + a.name + ' (' + fmtSize(a.size) + ')'); dl.href = link.href; dl.target = '_blank'; dl.rel = 'noreferrer'; const d = el('div'); d.append(dl); w.append(d); }
  return w;
}
// nome do ícone (Lucide) para o tipo de arquivo
function iconFor(mime, name) {
  if (mime.startsWith('image/')) return 'file-image';
  if (mime.startsWith('video/')) return 'file-video';
  if (mime.startsWith('audio/')) return 'file-music';
  if (/zip|rar|7z|tar|gzip/.test(mime) || /\.(zip|rar|7z)$/i.test(name)) return 'file-archive';
  if (/pdf/.test(mime)) return 'file-text';
  if (/spreadsheet|excel|csv/.test(mime) || /\.(xlsx?|csv|ods)$/i.test(name)) return 'file-spreadsheet';
  if (/\.(exe|msi|apk)$/i.test(name)) return 'file-cog';
  if (mime.startsWith('text/')) return 'file-type';
  return 'file';
}

// composer
const input = $('#msgInput');
let typingSent = 0;
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  $('#btnSend').classList.toggle('pronto', !!input.value.trim() || pendentes.length > 0);
  if (Date.now() - typingSent > 2500) { typingSent = Date.now(); send({ t: 'typing', channel: S.current }); }
});
$('#btnSend').onclick = () => { submitText(); input.focus(); };
input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.respondendo) cancelarResposta(); });
function submitText() {
  if (pendentes.length) return enviarComAnexos();
  const text = input.value;
  if (!text.trim()) return;
  if (!S.connected || !send({ t: 'msg', channel: S.current, text, respondendo: S.respondendo ? S.respondendo.id : undefined })) return toast('Sem conexão: sua mensagem continua na caixa.');
  input.value = ''; input.style.height = 'auto'; typingSent = 0;
  cancelarResposta();
  $('#btnSend').classList.remove('pronto');
}

// ---------------------------------------------------------------- responder, reagir, editar
function responder(m) {
  if (m.channel !== S.current) openText(m.channel);
  S.respondendo = { id: m.id, canal: m.channel, author: m.author, text: m.text ? m.text.slice(0, 120) : (m.attachments && m.attachments[0] ? `[anexo: ${m.attachments[0].name}]` : '') };
  const bar = $('#respondendo');
  const fechar = el('button', 'icon'); fechar.type = 'button'; fechar.title = 'Cancelar resposta (Esc)'; fechar.append(ic('x')); fechar.onclick = cancelarResposta;
  bar.replaceChildren(ic('reply'), el('span', null, 'Respondendo a '), el('b', null, m.author), el('span', 'trecho', S.respondendo.text), fechar);
  bar.classList.remove('hidden');
  input.focus();
}
function cancelarResposta() { S.respondendo = null; $('#respondendo').classList.add('hidden'); $('#respondendo').replaceChildren(); }

const EMOJIS_RAPIDOS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
function reagir(m, emoji) {
  if (!S.me.uid) return toast('Atualize o DJAchat para reagir.');
  send({ t: 'reagir', channel: m.channel, id: m.id, emoji });
}

function editarMensagem(m) {
  const row = $('#messages').querySelector(`.msg[data-id="${m.id}"]`);
  if (!row) return;
  const corpo = row.querySelector('.corpo');
  const atual = corpo.querySelector('.text');
  const caixa = el('textarea', 'edicao'); caixa.value = m.text || ''; caixa.rows = Math.min(8, (m.text || '').split('\n').length + 1);
  const dica = el('div', 'muted small', 'Enter salva · Esc cancela · Shift+Enter pula linha');
  const sair = () => atualizarLinha(m);
  caixa.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); sair(); }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const novo = caixa.value;
      if (novo.trim() === (m.text || '').trim()) return sair();
      if (!novo.trim() && !(m.attachments || []).length) return toast('Para tirar todo o texto, apague a mensagem.');
      send({ t: 'msg_edit', channel: m.channel, id: m.id, text: novo });
      sair();
    }
  };
  if (atual) atual.replaceWith(caixa, dica); else corpo.querySelector('.meta') ? corpo.querySelector('.meta').after(caixa, dica) : corpo.prepend(caixa, dica);
  caixa.focus(); caixa.setSelectionRange(caixa.value.length, caixa.value.length);
}
function apagarMensagem(m) {
  confirmModal('Apagar mensagem?', 'Ela some para todo mundo, junto com os anexos.', () => send({ t: 'msg_delete', channel: m.channel, id: m.id }));
}
function renderTyping() {
  const now = Date.now();
  const t = S.typing[S.current] || {};
  const names = Object.values(t).filter((x) => x.until > now).map((x) => x.name);
  $('#typing').textContent = names.length ? (names.length === 1 ? `${names[0]} está digitando…` : `${names.join(', ')} estão digitando…`) : '';
}
setInterval(renderTyping, 1500);

// arquivos: anexar, arrastar ou colar só coloca na bandeja; o envio é no Enter ou no botão Enviar
const MAX_ANEXOS = 10, MAX_ARQUIVO = 500 * 1024 * 1024;
const pendentes = [];   // { file, url }  (url = miniatura de imagem)
function adicionarAnexos(files) {
  for (const f of files) {
    if (pendentes.length >= MAX_ANEXOS) { toast(`No máximo ${MAX_ANEXOS} arquivos por mensagem`); break; }
    if (f.size > MAX_ARQUIVO) { toast(`"${f.name}" passa de 500 MB`); continue; }
    pendentes.push({ file: f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
  }
  renderAnexos();
  input.focus();
}
function renderAnexos() {
  const box = $('#anexos'); box.replaceChildren();
  pendentes.forEach((p, i) => {
    const c = el('div', 'anexo'); c.title = p.file.name || 'colado.png';
    if (p.url) { const img = el('img'); img.src = p.url; img.alt = ''; c.append(img); }
    else { const ico = el('div', 'ico'); ico.append(ic(iconFor(p.file.type || '', p.file.name || ''))); c.append(ico); }
    c.append(el('div', 'nome', p.file.name || 'colado.png'), el('div', 'muted', fmtSize(p.file.size)));
    const x = el('button', 'x'); x.append(ic('x')); x.type = 'button'; x.title = 'Remover anexo';
    x.onclick = () => { const [r] = pendentes.splice(i, 1); if (r.url) URL.revokeObjectURL(r.url); renderAnexos(); input.focus(); };
    c.append(x);
    box.append(c);
  });
  const conversa = canalInfo(S.current);
  input.placeholder = pendentes.length ? 'Escreva uma mensagem (opcional) e aperte Enter'
    : conversa && conversa.kind === 'dm' ? `Mensagem para ${conversa.name}` : 'Conversar…';
  $('#btnSend').classList.toggle('pronto', !!input.value.trim() || pendentes.length > 0);
}
$('#btnAttach').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { adicionarAnexos([...e.target.files]); e.target.value = ''; };
const tv = $('#textView');
let dragDepth = 0;
tv.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#dropHint').classList.remove('hidden'); } });
tv.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').classList.add('hidden'); } });
tv.addEventListener('dragover', (e) => e.preventDefault());
tv.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#dropHint').classList.add('hidden'); adicionarAnexos([...e.dataTransfer.files]); });
// soltar um arquivo fora da área do chat não pode abrir o arquivo no lugar do app
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
// ---------------------------------------------------------------- @ ao digitar: lista de apelidos
const sug = { lista: [], sel: 0, ini: -1, no: null };
function fecharSugestoes() {
  if (sug.no) { sug.no.remove(); sug.no = null; }
  sug.lista = []; sug.sel = 0;
}
function atualizarSugestoes() {
  const pos = input.selectionStart;
  if (pos !== input.selectionEnd) return fecharSugestoes();
  const m = /(^|\s)@([^\s@]{0,32})$/.exec(input.value.slice(0, pos));
  if (!m) return fecharSugestoes();
  const q = m[2].toLowerCase();
  const online = new Set(S.users.map((u) => u.name));
  const lista = nomesConhecidos().filter((n) => n !== S.me.name && n.toLowerCase().startsWith(q))
    .sort((a, b) => (online.has(b) - online.has(a)) || a.localeCompare(b)).slice(0, 8);
  if ('todos'.startsWith(q)) lista.push('todos');
  if (!lista.length) return fecharSugestoes();
  sug.lista = lista; sug.ini = pos - m[2].length - 1; sug.sel = Math.min(sug.sel, lista.length - 1);
  if (!sug.no) { sug.no = el('div'); sug.no.id = 'sugestoes'; $('#textView').append(sug.no); }
  sug.no.replaceChildren(el('div', 'titulo', 'Mencionar'));
  lista.forEach((nome, i) => {
    const b = el('button', 'opcao' + (i === sug.sel ? ' sel' : '')); b.type = 'button';
    const u = S.users.find((x) => x.name === nome);
    const av = el('div', 'avatar');
    if (nome === 'todos') av.append(ic('at-sign')); else paintAvatar(av, u || { name: nome });
    if (nome === 'todos') av.style.background = 'var(--bg4)';
    b.append(av, el('span', null, nome === 'todos' ? '@todos — avisa todo mundo' : nome));
    if (u) b.append(el('span', 'muted small', 'online'));
    b.onmousedown = (e) => { e.preventDefault(); escolherSugestao(i); };
    sug.no.append(b);
  });
  // logo acima da caixa de mensagem
  const tv = $('#textView').getBoundingClientRect(), cx = $('#composer').getBoundingClientRect();
  sug.no.style.bottom = (tv.bottom - cx.top + 6) + 'px';
}
function escolherSugestao(i) {
  const nome = sug.lista[i];
  const fim = input.selectionStart;
  const texto = '@' + nome + ' ';
  input.value = input.value.slice(0, sug.ini) + texto + input.value.slice(fim);
  const p = sug.ini + texto.length;
  input.setSelectionRange(p, p);
  fecharSugestoes();
  input.dispatchEvent(new Event('input'));
}
// fase de captura: roda antes do Enter que envia a mensagem
input.addEventListener('keydown', (e) => {
  if (!sug.lista.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopImmediatePropagation();
    sug.sel = (sug.sel + (e.key === 'ArrowDown' ? 1 : -1) + sug.lista.length) % sug.lista.length;
    atualizarSugestoes();
  } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault(); e.stopImmediatePropagation();
    escolherSugestao(sug.sel);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    fecharSugestoes();
  }
}, true);
input.addEventListener('input', atualizarSugestoes);
input.addEventListener('click', atualizarSugestoes);
input.addEventListener('blur', () => setTimeout(fecharSugestoes, 100));

input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); adicionarAnexos(files); }
});

function upload(file, kind = 'file', extra = '') {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${S.base}/api/upload?kind=${kind}${extra}`);
    xhr.setRequestHeader('x-token', S.token);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'colado.png'));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    const row = el('div', 'up'); const prog = el('progress'); prog.max = 1; prog.value = 0;
    const nomeUp = el('span'); nomeUp.append(ic('upload'), file.name || 'arquivo');
    row.append(nomeUp, prog, el('span', null, fmtSize(file.size)));
    if (kind === 'file') $('#uploads').append(row);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) prog.value = e.loaded / e.total; };
    xhr.onload = () => {
      row.remove(); let r = {}; try { r = JSON.parse(xhr.responseText); } catch { /* */ }
      // pelo túnel da Cloudflare, sem OneDrive, quem barra é ela e a resposta não traz o motivo
      const motivo = r.error || (xhr.status === 413 ? 'arquivo grande demais (sem OneDrive, o limite pelo endereço público é 100 MB)' : 'falha no envio');
      xhr.status === 200 ? resolve(r) : reject(new Error(motivo));
    };
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
  const nomeUp = el('span'); nomeUp.append(ic('upload'), nome);
  row.append(nomeUp, prog, el('span', null, fmtSize(file.size)));
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

// Envia o texto da caixa junto com os anexos da bandeja, numa mensagem só.
// Se falhar, o texto e os anexos voltam para a caixa, para tentar de novo.
async function enviarComAnexos() {
  if (!S.current) return;
  if (!S.connected) return toast('Sem conexão: seus anexos continuam na caixa.');
  const channel = S.current;
  const resposta = S.respondendo;
  const itens = pendentes.splice(0);
  const text = input.value;
  input.value = ''; input.style.height = 'auto'; typingSent = 0;
  renderAnexos();
  try {
    const atts = await Promise.all(itens.map((p) => enviarArquivo(p.file)));
    if (!S.connected || !send({ t: 'msg', channel, text, attachments: atts.map((a) => ({ id: a.id })), respondendo: resposta ? resposta.id : undefined })) throw new Error('sem conexão com o servidor');
    if (S.respondendo === resposta) cancelarResposta();
    for (const p of itens) if (p.url) URL.revokeObjectURL(p.url);
  } catch (err) {
    toast('Erro ao enviar: ' + err.message);
    pendentes.unshift(...itens.slice(0, MAX_ANEXOS - pendentes.length));
    if (text && !input.value) input.value = text;
    renderAnexos();
  }
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
  const f = { join: [520, 780], leave: [700, 420], msg: [880, 880], mencao: [660, 990] }[kind];
  o.frequency.setValueAtTime(f[0], ac.currentTime); o.frequency.linearRampToValueAtTime(f[1], ac.currentTime + 0.12);
  g.gain.setValueAtTime(kind === 'msg' ? 0.04 : kind === 'mencao' ? 0.07 : 0.08, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
  o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.26);
}

// ================================================================ voz (WebRTC em malha: cada um conecta com cada um)
async function joinVoice(id) {
  if (S.voice === id) return showVoiceView();
  // dois cliques seguidos abririam dois microfones, e um ficaria ligado para sempre
  if (S.entrandoVoz) return;
  S.entrandoVoz = true;
  try {
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
  } finally { S.entrandoVoz = false; }
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
  // assistindo: essa pessoa pediu para ver a minha tela (só ela recebe o vídeo)
  p = { id: pid, pc, polite: S.me.id > pid, makingOffer: false, ignoreOffer: false, audios: new Map(), stopMeter: null, screenSenders: [], assistindo: false };
  S.peers.set(pid, p);

  // sempre negocia uma faixa de áudio (mesmo sem microfone, para conseguir ouvir)
  const micTrack = S.mic && S.mic.getAudioTracks()[0];
  if (micTrack) pc.addTrack(micTrack, S.mic);
  else pc.addTransceiver('audio', { direction: 'recvonly' });
  if (S.screen && p.assistindo) addScreenTo(p);

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
      // o primeiro áudio de cada pessoa é o microfone; os outros vêm da tela compartilhada
      if (!p.vozId) p.vozId = stream.id;
      const a = new Audio(); a.autoplay = true; a.srcObject = stream;
      const item = { a, tipo: stream.id === p.vozId ? 'voz' : 'tela', ganho: null };
      p.audios.set(stream.id, item);
      applyVolume(p, item);
      if (S.outputId && a.setSinkId) a.setSinkId(S.outputId).catch(() => {});
      a.play().catch(() => {});
      if (item.tipo === 'voz' && !p.stopMeter) p.stopMeter = watchLevel(stream, (on) => setSpeaking(pid, on));
      stream.addEventListener('removetrack', () => { if (!stream.getTracks().length) { desligarAudio(item); p.audios.delete(stream.id); } });
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
  // pedido para começar ou parar de assistir a minha tela
  if (data && 'assistir' in data) {
    p.assistindo = !!data.assistir;
    if (S.screen) { if (p.assistindo) addScreenTo(p); else removeScreenFrom(p); }
    atualizarPlateia();
    return;
  }
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
  for (const item of p.audios.values()) desligarAudio(item);
  try { p.pc.close(); } catch { /* */ }
  removeScreenTile(pid);
  setSpeaking(pid, false);
}

function teardownVoice() {
  for (const id of [...S.peers.keys()]) closePeer(id);
  if (S.screen) stopScreen(true);
  S.assistindo.clear();
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

// Volume de cada pessoa (0 a 200%). Até 100% usa o próprio elemento de áudio; acima disso,
// o som passa por um amplificador do Web Audio e o elemento fica mudo para não tocar duas vezes.
function volumeDe(u, tipo) {
  const k = chavePessoa(u);
  if (tipo === 'tela') return S.volTela[k] ?? 1;
  return S.volumes[k] ?? S.userVol[u.name] ?? 1;
}
function applyVolume(p, item) {
  const u = S.users.find((x) => x.id === p.id) || { name: p.id };
  const silencio = S.deafened || (item.tipo === 'voz' && S.mutados.has(chavePessoa(u)));
  const vol = volumeDe(u, item.tipo);
  if (silencio) { item.a.muted = true; if (item.ganho) item.ganho.gain.value = 0; return; }
  if (vol <= 1) {
    item.a.muted = false; item.a.volume = vol;
    if (item.ganho) item.ganho.gain.value = 0;
    return;
  }
  if (!item.ganho) {
    const ac = ctx();
    item.fonte = ac.createMediaStreamSource(item.a.srcObject);
    item.ganho = ac.createGain();
    item.fonte.connect(item.ganho).connect(ac.destination);
    if (S.outputId && ac.setSinkId) ac.setSinkId(S.outputId).catch(() => {});
  }
  item.a.muted = true;
  item.ganho.gain.value = vol;
}
function desligarAudio(item) {
  item.a.srcObject = null;
  if (item.fonte) { try { item.fonte.disconnect(); item.ganho.disconnect(); } catch { /* */ } }
}
function aplicarVolumesDe(uid) {
  const p = S.peers.get(uid);
  if (p) for (const item of p.audios.values()) applyVolume(p, item);
}
function nameOf(id) { const u = S.users.find((x) => x.id === id); return u ? u.name : id; }

function renderVoiceView() {
  if (!S.voice) { $('#tiles').replaceChildren(); return; }
  const ch = S.channels.find((c) => c.id === S.voice);
  if (S.view === 'voice') { $('#chanTitle').replaceChildren(ic('volume-2'), ch ? ch.name : ''); $('#chanSub').textContent = 'canal de voz'; }
  const tiles = $('#tiles'); tiles.replaceChildren();
  const members = S.users.filter((u) => u.voice === S.voice);
  for (const u of members) {
    const t = el('div', 'tile'); t.dataset.uid = u.id;
    t.oncontextmenu = (e) => menuPessoa(e, u);
    const av = el('div', 'avatar'); paintAvatar(av, u);
    t.append(av, el('div', null, u.name + (u.id === S.me.id ? ' (você)' : '')));
    const flags = el('div', 'flags');
    if (u.sharing) flags.append(seloAoVivo(u));
    if (u.deafened) flags.append(ic('headphone-off')); else if (u.muted) flags.append(ic('mic-off'));
    if (u.id !== S.me.id && S.mutados.has(chavePessoa(u))) flags.append(ic('volume-x', 'mutado-por-mim'));
    t.append(flags);
    if (u.id !== S.me.id) {
      const vol = el('input', 'vol'); vol.type = 'range'; vol.min = 0; vol.max = 2; vol.step = 0.05;
      vol.value = volumeDe(u, 'voz'); vol.title = `Volume de ${u.name} (clique direito para mais opções)`;
      vol.oninput = () => definirVolume(u, 'voz', Number(vol.value));
      t.append(vol);
    }
    tiles.append(t);
  }
  $('#voiceHint').textContent = members.length <= 1 ? 'Ninguém mais por aqui ainda. Chama a galera!' : '';
  renderConvites();
  paintSpeaking();
}

// ================================================================ mute / deafen
function refreshButtons() {
  $('#btnMute').classList.toggle('off', S.muted || S.deafened);
  $('#btnDeafen').classList.toggle('off', S.deafened);
  rotular($('#btnMute'), S.muted || S.deafened ? 'mic-off' : 'mic');
  rotular($('#btnDeafen'), S.deafened ? 'headphone-off' : 'headphones');
  $('#btnMute').title = S.muted ? 'Desmutar' : 'Mutar microfone';
  $('#btnDeafen').title = S.deafened ? 'Voltar a ouvir' : 'Ensurdecer';
  if (S.mic) S.mic.getAudioTracks().forEach((t) => (t.enabled = !S.muted && !S.deafened));
  for (const p of S.peers.values()) for (const item of p.audios.values()) applyVolume(p, item);
  if (S.muted || S.deafened) setSpeaking(S.me?.id, false);
  informarEstado();
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
  // a tela só vai para quem clicar em Assistir: poupa a internet de quem transmite
  for (const p of S.peers.values()) if (p.assistindo) addScreenTo(p);
  addScreenTile(S.me.id, stream, true);
  atualizarPlateia();
  $('#btnScreen').classList.add('on'); rotular($('#btnScreen'), 'screen-share-off', 'Parar');
  pushVoiceState();
}

function addScreenTo(p) {
  if (p.screenSenders.length) return;   // já está recebendo
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

function removeScreenFrom(p) {
  for (const s of p.screenSenders) { try { p.pc.removeTrack(s); } catch { /* */ } }
  p.screenSenders = [];
}

function stopScreen(silent) {
  if (!S.screen) return;
  S.screen.getTracks().forEach((t) => t.stop());
  // na próxima vez, cada um escolhe de novo se quer assistir
  for (const p of S.peers.values()) { removeScreenFrom(p); p.assistindo = false; }
  S.screen = null;
  removeScreenTile(S.me.id);
  $('#btnScreen').classList.remove('on'); rotular($('#btnScreen'), 'screen-share', 'Tela');
  if (!silent) pushVoiceState();
}

function addScreenTile(uid, stream, local) {
  let t = document.querySelector(`.screen-tile[data-screen="${uid}"]`);
  if (!t) {
    t = el('div', 'screen-tile'); t.dataset.screen = uid;
    const v = el('video'); v.autoplay = true; v.playsInline = true; v.muted = true;
    const label = el('div', 'label'); label.append(ic('monitor'), local ? 'Sua tela' : nameOf(uid));
    if (local) label.append(el('span', 'plateia'));
    const tools = el('div', 'tools');
    if (!local) {
      const sair = el('button'); sair.append(ic('eye-off')); sair.title = 'Parar de assistir';
      sair.onclick = (e) => { e.stopPropagation(); assistir(uid, false); };
      tools.append(sair);
    }
    const focus = el('button'); focus.append(ic('maximize-2')); focus.title = 'Focar';
    focus.onclick = () => {
      const st = $('#stage'); const on = !t.classList.contains('focused');
      st.querySelectorAll('.screen-tile').forEach((x) => x.classList.remove('focused'));
      t.classList.toggle('focused', on); st.classList.toggle('focus', on);
    };
    const fs = el('button'); fs.append(ic('fullscreen')); fs.title = 'Tela cheia'; fs.onclick = () => t.requestFullscreen();
    tools.append(focus, fs); t.append(v, label, tools);
    t.oncontextmenu = (e) => menuTela(e, uid, local, t, focus);
    t.ondblclick = () => (document.fullscreenElement ? document.exitFullscreen() : t.requestFullscreen());
    $('#stage').append(t);
  }
  const v = t.querySelector('video');
  if (v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
  renderConvites();
}
function removeScreenTile(uid) {
  const t = document.querySelector(`.screen-tile[data-screen="${uid}"]`);
  if (t) { const st = $('#stage'); if (t.classList.contains('focused')) st.classList.remove('focus'); t.remove(); }
  renderConvites();
}

// ---------------------------------------------------------------- assistir a tela dos outros
// Quem compartilha só envia o vídeo para quem pediu; o pedido vai pela sinalização da sala.
function assistir(uid, sim) {
  if (sim) S.assistindo.add(uid); else S.assistindo.delete(uid);
  send({ t: 'signal', to: uid, data: { assistir: sim } });
  if (!sim) removeScreenTile(uid);
  renderConvites();
}

// "AO VIVO" de alguém na minha sala também serve de atalho para assistir
function seloAoVivo(u) {
  const s = el('span', 'live', 'AO VIVO');
  if (S.voice && u.voice === S.voice && u.id !== S.me?.id) {
    s.classList.add('clicavel'); s.title = 'Assistir a tela de ' + u.name;
    s.onclick = (e) => { e.stopPropagation(); showVoiceView(); if (!S.assistindo.has(u.id)) assistir(u.id, true); };
  }
  return s;
}

// Um cartão "Fulano está compartilhando" para cada tela que eu ainda não estou vendo
function renderConvites() {
  const stage = $('#stage');
  const compartilhando = S.voice && S.me ? S.users.filter((u) => u.voice === S.voice && u.sharing && u.id !== S.me.id) : [];
  for (const uid of [...S.assistindo]) if (!compartilhando.some((u) => u.id === uid)) S.assistindo.delete(uid);
  stage.querySelectorAll('.convite').forEach((c) => c.remove());
  for (const u of compartilhando) {
    if (stage.querySelector(`.screen-tile[data-screen="${u.id}"]`)) continue;
    const c = el('div', 'convite'); c.dataset.convite = u.id;
    const av = el('div', 'avatar'); paintAvatar(av, u);
    const txt = el('div', 'txt'); txt.append(el('b', null, u.name), ' está compartilhando a tela');
    const b = el('button', 'primary');
    if (S.assistindo.has(u.id)) { rotular(b, 'eye', 'Conectando…'); b.disabled = true; }
    else { rotular(b, 'eye', 'Assistir'); b.onclick = () => assistir(u.id, true); }
    c.append(av, txt, b);
    stage.append(c);
  }
}

// Na minha tela: quantas pessoas estão assistindo
function atualizarPlateia() {
  const n = [...S.peers.values()].filter((p) => p.assistindo).length;
  const span = document.querySelector(`.screen-tile[data-screen="${S.me?.id}"] .plateia`);
  if (span) span.textContent = n ? ` · ${n} assistindo` : ' · ninguém assistindo ainda';
}

// Electron: seletor em duas etapas — 1) tela ou aplicativo, 2) qual deles — e só então Compartilhar
if (window.djachatDesktop) {
  window.djachatDesktop.onPickSource((sources) => {
    const grupos = {
      tela: { nome: 'Tela', icone: 'monitor', descricao: 'A tela inteira, com tudo o que aparecer nela', lista: sources.filter((s) => s.id.startsWith('screen:')) },
      app: { nome: 'Aplicativo', icone: 'app-window', descricao: 'Só a janela de um programa', lista: sources.filter((s) => !s.id.startsWith('screen:')) },
    };
    let chosen = null;
    const body = el('div');
    const ok = () => $('#modalOk');

    // som do PC: a escolha fica guardada entre as duas etapas
    const chk = el('input'); chk.type = 'checkbox'; chk.id = 'shareAudio'; chk.checked = LS.get('shareSystemAudio', false); chk.style.width = 'auto';

    function etapaTipo() {
      chosen = null;
      ok().classList.add('hidden');
      $('#modalTitle').textContent = 'O que você quer compartilhar?';
      const tipos = el('div', 'tipos');
      for (const [chave, g] of Object.entries(grupos)) {
        const b = el('button', 'tipo'); b.type = 'button'; b.dataset.tipo = chave;
        b.append(ic(g.icone), el('b', null, g.nome), el('span', 'muted small', g.descricao),
          el('span', 'muted small', g.lista.length === 1 ? '1 disponível' : `${g.lista.length} disponíveis`));
        b.disabled = !g.lista.length;
        b.onclick = () => etapaItem(chave);
        tipos.append(b);
      }
      body.replaceChildren(tipos, el('div', 'muted small dica', 'Só quem clicar em Assistir recebe a sua tela.'));
    }

    function etapaItem(chave) {
      const g = grupos[chave];
      chosen = null;
      $('#modalTitle').textContent = chave === 'tela' ? 'Escolha a tela' : 'Escolha o aplicativo';
      const voltar = el('button', 'voltar'); voltar.type = 'button'; voltar.textContent = '← Tela ou aplicativo';
      voltar.onclick = etapaTipo;
      const grid = el('div', 'sources');
      const resumo = el('div', 'resumo muted small', 'Clique para escolher.');
      for (const s of g.lista) {
        const b = el('div', 'source'); b.dataset.id = s.id; b.title = s.name;
        const img = el('img'); img.src = s.thumbnail; img.alt = '';
        b.append(img, el('div', null, s.name));
        b.onclick = () => {
          chosen = s.id;
          grid.querySelectorAll('.source').forEach((x) => x.classList.toggle('sel', x === b));
          resumo.replaceChildren('Você vai compartilhar: ', el('b', null, s.name));
          ok().disabled = false;
        };
        b.ondblclick = () => { b.onclick(); ok().click(); };
        grid.append(b);
      }
      const audioRow = el('div', 'row');
      const lab = el('label', null, 'Compartilhar o som do PC (Windows). Quem está na chamada pode ouvir o próprio eco.'); lab.htmlFor = 'shareAudio';
      audioRow.append(chk, lab);
      body.replaceChildren(voltar, grid, resumo, audioRow);
      ok().classList.remove('hidden');
      ok().disabled = true;   // só libera depois de escolher
    }

    openModal('Compartilhar tela', body, 'Compartilhar', () => {
      LS.set('shareSystemAudio', chk.checked);
      window.djachatDesktop.pickSource(chosen, chk.checked);
    }, () => window.djachatDesktop.pickSource(null, false));
    etapaTipo();
  });
}

// ================================================================ soundboard
$('#btnSoundboard').onclick = (e) => { e.stopPropagation(); $('#soundboard').classList.toggle('hidden'); };
document.addEventListener('click', (e) => { if (!e.target.closest('#soundboard') && !e.target.closest('#modal') && !e.target.closest('.menu')) $('#soundboard').classList.add('hidden'); });
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
    b.oncontextmenu = (e) => menuSom(e, s);
    b.append(el('span', 'em', s.emoji || '🔊'), s.name);
    const x = el('button', 'x'); x.append(ic('x')); x.title = 'Remover som';
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
  // conta leve: o código deste PC; serve para usar o mesmo apelido em outro PC
  const conta = el('div', 'conta');
  conta.append(el('label', null, 'Sua conta'), el('div', 'muted small', 'Este código é a sua conta: quem tem ele usa o seu apelido e mexe nas suas mensagens. Para entrar como você em outro PC, copie aqui e cole lá. Não passe para ninguém.'));
  const linhaConta = el('div', 'row');
  const bCopiar = el('button'); bCopiar.type = 'button'; rotular(bCopiar, 'copy', 'Copiar código');
  bCopiar.onclick = () => copiarTexto(chaveConta(), 'Código copiado');
  const bUsar = el('button'); bUsar.type = 'button'; rotular(bUsar, 'key-round', 'Usar código de outro PC');
  bUsar.onclick = () => {
    cleanup();
    promptModal('Usar código de outro PC', 'Cole o código da conta', '', (v) => {
      v = v.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(v)) return toast('Esse código não é válido.');
      LS.set('chave', v); toast('Conta trocada. Reconectando…');
      if (S.ws) S.ws.close();
    });
  };
  linhaConta.append(bCopiar, bUsar); conta.append(linhaConta); body.append(conta);
  if (S.hospedavel) {
    // leva o servidor para outro PC sem refazer a conexão com o OneDrive
    const hosp = el('div', 'conta');
    hosp.append(el('label', null, 'Hospedar em outro PC'), el('div', 'muted small', 'Copie este código e cole no conectar-onedrive.bat do PC que vai hospedar. Ele só funciona junto com a senha do servidor, e liga aquele PC aos dados do grupo no OneDrive.'));
    const bHosp = el('button'); bHosp.type = 'button'; rotular(bHosp, 'copy', 'Copiar código para hospedar'); bHosp.id = 'btnCodigoHospedar';
    bHosp.onclick = () => send({ t: 'codigo_hospedagem' });
    const linhaHosp = el('div', 'row'); linhaHosp.append(bHosp); hosp.append(linhaHosp); body.append(hosp);
  }
  if (desktop && desktop.janela) body.append(opcoesDaJanela());
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
    for (const p of S.peers.values()) for (const item of p.audios.values()) if (item.a.setSinkId) item.a.setSinkId(S.outputId).catch(() => {});
    if (S.audioCtx && S.audioCtx.setSinkId) S.audioCtx.setSinkId(S.outputId).catch(() => {});
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

// ================================================================ janela (app desktop)
// A moldura do Windows e o menu File/Edit saíram; a barra é do app e o resto foi para Configurações.
const desktop = window.djachatDesktop;
const janela = (acao, valor) => desktop && desktop.janela && desktop.janela(acao, valor);
S.zoom = LS.get('zoom', 1);
S.fecharParaBandeja = LS.get('fecharParaBandeja', true);   // o X esconde na bandeja (padrão) ou fecha o app
function atualizarBotaoFechar() {
  $('#jFechar').title = S.fecharParaBandeja ? 'Fechar (o DJAchat continua na bandeja)' : 'Fechar o DJAchat';
}
// chamada também durante o carregamento (refreshButtons), então não usa nada declarado mais abaixo
function informarEstado() {
  const d = window.djachatDesktop;
  if (!d || !d.informarEstado) return;
  const ch = S.voice && S.channels.find((c) => c.id === S.voice);
  const estado = { conectado: !!S.connected, voz: ch ? ch.name : null, mutado: !!S.muted, surdo: !!S.deafened };
  const txt = JSON.stringify(estado);
  if (txt !== S.ultimoEstadoInformado) { S.ultimoEstadoInformado = txt; d.informarEstado(estado); }
}
function definirZoom(v) {
  S.zoom = Math.round(Math.min(2, Math.max(0.5, v)) * 10) / 10;
  LS.set('zoom', S.zoom);
  janela('zoom', S.zoom);
  const z = document.querySelector('.janela-opcoes .zoom'); if (z) z.textContent = Math.round(S.zoom * 100) + '%';
}
if (desktop && desktop.janela) {
  document.body.classList.add('com-barra');
  $('#barraJanela').classList.remove('hidden');
  $('#jMinimizar').onclick = () => janela('minimizar');
  $('#jMaximizar').onclick = () => janela('maximizar');
  $('#jFechar').onclick = () => janela(S.fecharParaBandeja ? 'fechar' : 'sair');
  atualizarBotaoFechar();
  desktop.aoMudarJanela((estado) => {
    if ('telaCheia' in estado) document.body.classList.toggle('tela-cheia', !!estado.telaCheia);
    if ('maximizada' in estado) {
      rotular($('#jMaximizar'), estado.maximizada ? 'copy' : 'square');
      $('#jMaximizar').title = estado.maximizada ? 'Restaurar' : 'Maximizar';
    }
  });
  // comandos escolhidos no menu da bandeja
  desktop.aoComando((c) => {
    if (c === 'mutar') $('#btnMute').click();
    else if (c === 'ensurdecer') $('#btnDeafen').click();
    else if (c === 'sair-voz') send({ t: 'voice_leave' });
    else if (c === 'configuracoes' && S.me) $('#btnSettings').click();
  });
  if (S.zoom !== 1) janela('zoom', S.zoom);
  // atalhos que vinham do menu padrão
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); definirZoom(S.zoom + 0.1); }
    else if (e.ctrlKey && !e.altKey && e.key === '-') { e.preventDefault(); definirZoom(S.zoom - 0.1); }
    else if (e.ctrlKey && !e.altKey && e.key === '0') { e.preventDefault(); definirZoom(1); }
    else if (e.key === 'F11') { e.preventDefault(); janela('tela-cheia'); }
    else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); janela('devtools'); }
  });
}
function opcoesDaJanela() {
  const w = el('div', 'janela-opcoes');
  w.append(el('label', null, 'Janela e app'));
  const botao = (icone, texto, acao, classe) => { const b = el('button', classe || null); b.type = 'button'; rotular(b, icone, texto); b.onclick = acao; return b; };
  const zoom = el('div', 'row');
  const atual = el('span', 'zoom', Math.round(S.zoom * 100) + '%');
  zoom.append(el('span', 'muted small', 'Zoom'), botao('zoom-out', '', () => definirZoom(S.zoom - 0.1)), atual,
    botao('zoom-in', '', () => definirZoom(S.zoom + 0.1)), botao('refresh-cw', 'Tamanho normal', () => definirZoom(1)));
  zoom.querySelectorAll('button')[0].title = 'Diminuir (Ctrl -)'; zoom.querySelectorAll('button')[1].title = 'Aumentar (Ctrl +)';
  const fechar = el('div', 'row');
  const chk = el('input'); chk.type = 'checkbox'; chk.id = 'fecharBandeja'; chk.checked = S.fecharParaBandeja; chk.style.width = 'auto';
  const lab = el('label', null, 'Fechar (X) deixa o DJAchat aberto na bandeja'); lab.htmlFor = 'fecharBandeja';
  chk.onchange = () => { S.fecharParaBandeja = chk.checked; LS.set('fecharParaBandeja', chk.checked); atualizarBotaoFechar(); };
  fechar.append(chk, lab);
  const outros = el('div', 'row');
  outros.append(
    botao('expand', 'Tela cheia (F11)', () => janela('tela-cheia')),
    botao('refresh-cw', 'Recarregar o app', () => confirmModal('Recarregar o app?', 'Se estiver numa sala de voz, você sai e volta em seguida.', () => janela('recarregar'))),
    botao('code', 'Ferramentas de desenvolvedor', () => janela('devtools')),
    botao('log-out', 'Sair do DJAchat', () => janela('sair'), 'sair'));
  w.append(zoom, fechar, outros);
  return w;
}

// ================================================================ menu de clique direito
let menuAberto = null;
function fecharMenu() { if (menuAberto) { menuAberto.remove(); menuAberto = null; } }

// itens: { rotulo, icone, acao, perigo } | { titulo } | { no: elemento } | '-' (separador) | null (pula)
function abrirMenu(e, itens) {
  // em campos de texto vale o menu do sistema (recortar, colar, corretor ortográfico)
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault(); e.stopPropagation();
  fecharMenu();
  const m = el('div', 'menu'); m.setAttribute('role', 'menu');
  let depoisDeSeparador = true;
  for (const it of itens) {
    if (!it) continue;
    if (it === '-') { if (!depoisDeSeparador) { m.append(el('div', 'sep')); depoisDeSeparador = true; } continue; }
    depoisDeSeparador = false;
    if (it.titulo) { m.append(el('div', 'titulo', it.titulo)); continue; }
    if (it.no) { m.append(it.no); continue; }
    const b = el('button', 'item' + (it.perigo ? ' perigo' : '')); b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.append(ic(it.icone), el('span', null, it.rotulo));
    b.onclick = () => { fecharMenu(); it.acao(); };
    m.append(b);
  }
  if (m.lastChild && m.lastChild.classList.contains('sep')) m.lastChild.remove();
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4)) + 'px';
  menuAberto = m;
}
document.addEventListener('mousedown', (e) => { if (menuAberto && !menuAberto.contains(e.target)) fecharMenu(); }, true);
document.addEventListener('wheel', (e) => { if (menuAberto && !menuAberto.contains(e.target)) fecharMenu(); }, { passive: true });
window.addEventListener('blur', fecharMenu);
window.addEventListener('resize', fecharMenu);
document.addEventListener('keydown', (e) => {
  if (!menuAberto) return;
  if (e.key === 'Escape') { e.stopPropagation(); fecharMenu(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const itens = [...menuAberto.querySelectorAll('button.item')];
  const i = itens.indexOf(document.activeElement);
  const prox = e.key === 'ArrowDown' ? (i + 1) % itens.length : (i - 1 + itens.length) % itens.length;
  if (itens[prox]) itens[prox].focus();
}, true);

// controle deslizante de volume dentro do menu (0 a 200%)
function controleVolume(rotulo, valor, aoMudar) {
  const w = el('div', 'menu-volume');
  const topo = el('div', 'topo'); const pct = el('span', 'pct', Math.round(valor * 100) + '%');
  topo.append(el('span', null, rotulo), pct);
  const r = el('input'); r.type = 'range'; r.min = 0; r.max = 2; r.step = 0.05; r.value = valor;
  r.oninput = () => { pct.textContent = Math.round(r.value * 100) + '%'; aoMudar(Number(r.value)); };
  w.append(topo, r);
  return w;
}

function copiarTexto(t, aviso = 'Copiado') {
  const d = window.djachatDesktop;
  const copia = d && d.copiarTexto ? d.copiarTexto(t) : navigator.clipboard.writeText(t);
  copia.then(() => toast(aviso)).catch(() => toast('Não consegui copiar.'));
}
function mencionar(nome) {
  if (S.view !== 'text' && S.current) openText(S.current);
  const ini = input.selectionStart ?? input.value.length, fim = input.selectionEnd ?? ini;
  const antes = input.value.slice(0, ini);
  const texto = (antes && !/\s$/.test(antes) ? ' ' : '') + '@' + nome + ' ';
  input.value = antes + texto + input.value.slice(fim);
  input.focus(); input.setSelectionRange(ini + texto.length, ini + texto.length);
  input.dispatchEvent(new Event('input'));
}
function abrirDm(u) {
  const id = idDm(u.uid);
  if (!S.dms.some((d) => d.id === id)) S.dms.push({ id, kind: 'dm', outro: u.uid, name: u.name });
  openText(id);
}
function definirVolume(u, tipo, v) {
  const k = chavePessoa(u);
  if (tipo === 'tela') { S.volTela[k] = v; LS.set('volTela', S.volTela); }
  else { S.volumes[k] = v; LS.set('volumes', S.volumes); }
  aplicarVolumesDe(u.id);
}
function alternarMudo(u) {
  const k = chavePessoa(u);
  if (S.mutados.has(k)) S.mutados.delete(k); else S.mutados.add(k);
  LS.set('mutados', [...S.mutados]);
  aplicarVolumesDe(u.id);
  renderMembers(); renderVoiceView();
}
function alternarSilencio(id) {
  if (S.silenciados.has(id)) S.silenciados.delete(id); else S.silenciados.add(id);
  LS.set('silenciados', [...S.silenciados]);
  toast(S.silenciados.has(id) ? 'Sem som de mensagem nova aqui' : 'Avisos de volta');
}

function menuPessoa(e, u) {
  if (u.id === S.me.id) return menuProprio(e);
  const mutado = S.mutados.has(chavePessoa(u));
  const naMinhaSala = !!S.voice && u.voice === S.voice;
  const outrasSalas = S.channels.filter((c) => c.kind === 'voice' && c.id !== u.voice);
  abrirMenu(e, [
    { titulo: u.name },
    naMinhaSala ? { no: controleVolume('Volume', volumeDe(u, 'voz'), (v) => definirVolume(u, 'voz', v)) } : null,
    naMinhaSala ? { rotulo: mutado ? 'Desmutar para mim' : 'Mutar para mim', icone: mutado ? 'volume-2' : 'volume-x', acao: () => alternarMudo(u) } : null,
    naMinhaSala && u.sharing ? (S.assistindo.has(u.id)
      ? { rotulo: 'Parar de assistir a tela', icone: 'eye-off', acao: () => assistir(u.id, false) }
      : { rotulo: 'Assistir a tela', icone: 'eye', acao: () => { showVoiceView(); assistir(u.id, true); } }) : null,
    '-',
    u.uid && S.me.uid ? { rotulo: 'Enviar mensagem direta', icone: 'message-square', acao: () => abrirDm(u) } : null,
    { rotulo: 'Mencionar', icone: 'at-sign', acao: () => mencionar(u.name) },
    { rotulo: 'Copiar nome', icone: 'copy', acao: () => copiarTexto(u.name, 'Nome copiado') },
    u.voice ? '-' : null,
    ...(u.voice ? outrasSalas.map((c) => ({ rotulo: 'Mover para ' + c.name, icone: 'arrow-right-left', acao: () => send({ t: 'voice_move', alvo: u.id, channel: c.id }) })) : []),
    u.voice ? { rotulo: 'Tirar da sala', icone: 'user-x', perigo: true, acao: () => confirmModal(`Tirar ${u.name} da sala?`, 'A pessoa sai da voz e fica sabendo que foi você.', () => send({ t: 'voice_kick', alvo: u.id })) } : null,
  ]);
}

function menuProprio(e) {
  abrirMenu(e, [
    { titulo: S.me.name + ' (você)' },
    { rotulo: S.muted ? 'Desmutar microfone' : 'Mutar microfone', icone: S.muted ? 'mic' : 'mic-off', acao: () => $('#btnMute').click() },
    { rotulo: S.deafened ? 'Voltar a ouvir' : 'Ensurdecer', icone: S.deafened ? 'headphones' : 'headphone-off', acao: () => $('#btnDeafen').click() },
    S.voice ? { rotulo: 'Sair da sala de voz', icone: 'phone-off', perigo: true, acao: () => send({ t: 'voice_leave' }) } : null,
    '-',
    { rotulo: 'Copiar meu nome', icone: 'copy', acao: () => copiarTexto(S.me.name, 'Nome copiado') },
    { rotulo: 'Configurações', icone: 'settings', acao: () => $('#btnSettings').click() },
  ]);
}
$('#userPanel').oncontextmenu = menuProprio;

function itensMensagem(m) {
  const sel = String(window.getSelection() || '').trim();
  const minha = souEu(m) && !!S.me.uid;
  let reacoes = null;
  if (S.me.uid) {
    reacoes = el('div', 'menu-reacoes');
    for (const emoji of EMOJIS_RAPIDOS) {
      const b = el('button', null, emoji); b.type = 'button'; b.title = 'Reagir com ' + emoji;
      b.onclick = () => { fecharMenu(); reagir(m, emoji); };
      reacoes.append(b);
    }
  }
  return [
    reacoes ? { no: reacoes } : null,
    { rotulo: 'Responder', icone: 'reply', acao: () => responder(m) },
    sel ? { rotulo: 'Copiar seleção', icone: 'copy', acao: () => copiarTexto(sel) } : null,
    m.text ? { rotulo: 'Copiar texto', icone: 'copy', acao: () => copiarTexto(m.text) } : null,
    { rotulo: 'Mencionar ' + m.author, icone: 'at-sign', acao: () => mencionar(m.author) },
    minha ? '-' : null,
    minha ? { rotulo: 'Editar', icone: 'pencil', acao: () => editarMensagem(m) } : null,
    minha ? { rotulo: 'Apagar', icone: 'trash-2', perigo: true, acao: () => apagarMensagem(m) } : null,
  ];
}
function menuMensagem(e, m) { abrirMenu(e, itensMensagem(m)); }

async function copiarImagem(a) {
  try {
    const blob = await (await fetch(fileUrl(a.id))).blob();
    let png = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      png = await new Promise((r) => c.toBlob(r, 'image/png'));
    }
    const d = window.djachatDesktop;
    if (d && d.copiarImagem) await d.copiarImagem(new Uint8Array(await png.arrayBuffer()));
    else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Imagem copiada');
  } catch { toast('Não consegui copiar a imagem.'); }
}
function baixarAnexo(a) {
  if (window.djachatDesktop && window.djachatDesktop.baixar) window.djachatDesktop.baixar(fileUrl(a.id, true));
  else window.open(fileUrl(a.id, true), '_blank', 'noreferrer');
}
function verImagem(a) {
  const lb = el('div', 'lightbox'); const i = el('img'); i.src = fileUrl(a.id); lb.append(i); lb.onclick = () => lb.remove(); document.body.append(lb);
}
function menuAnexo(e, a, m) {
  const imagem = a.mime.startsWith('image/');
  abrirMenu(e, [
    { titulo: a.name },
    imagem ? { rotulo: 'Ver em tamanho grande', icone: 'maximize', acao: () => verImagem(a) } : null,
    { rotulo: 'Abrir', icone: 'external-link', acao: () => window.open(fileUrl(a.id), '_blank', 'noreferrer') },
    { rotulo: 'Baixar…', icone: 'download', acao: () => baixarAnexo(a) },
    imagem ? { rotulo: 'Copiar imagem', icone: 'image', acao: () => copiarImagem(a) } : null,
    m ? '-' : null,
    ...(m ? itensMensagem(m) : []),
  ]);
}

function menuCanal(e, ch) {
  const silenciado = S.silenciados.has(ch.id);
  const itens = [{ titulo: ch.kind === 'text' ? '#' + ch.name : ch.name }];
  if (ch.kind === 'voice') {
    itens.push(S.voice === ch.id ? { rotulo: 'Ver a sala', icone: 'volume-2', acao: showVoiceView } : { rotulo: 'Entrar na sala', icone: 'log-in', acao: () => joinVoice(ch.id) });
  } else {
    itens.push({ rotulo: 'Abrir', icone: ch.kind === 'dm' ? 'at-sign' : 'hash', acao: () => openText(ch.id) });
    if (S.unread.has(ch.id)) itens.push({ rotulo: 'Marcar como lido', icone: 'check-check', acao: () => { S.unread.delete(ch.id); renderChannels(); } });
    itens.push({ rotulo: silenciado ? 'Reativar avisos' : 'Silenciar avisos', icone: silenciado ? 'bell' : 'bell-off', acao: () => alternarSilencio(ch.id) });
  }
  if (ch.kind !== 'dm') {
    itens.push('-',
      { rotulo: 'Renomear', icone: 'pencil', acao: () => promptModal('Renomear canal', 'Novo nome', ch.name, (name) => send({ t: 'channel_rename', id: ch.id, name })) },
      { rotulo: 'Apagar canal', icone: 'trash-2', perigo: true, acao: () => confirmModal(`Apagar "${ch.name}"?`, 'As mensagens do canal serão perdidas.', () => send({ t: 'channel_delete', id: ch.id })) });
  }
  abrirMenu(e, itens);
}

function menuSom(e, s) {
  abrirMenu(e, [
    { titulo: `${s.emoji || ''} ${s.name}`.trim() },
    S.voice ? { rotulo: 'Tocar para a sala', icone: 'play', acao: () => send({ t: 'sound_play', id: s.id }) } : null,
    { rotulo: 'Ouvir só para mim', icone: 'headphones', acao: () => playSound(s.id) },
    '-',
    { rotulo: 'Renomear', icone: 'pencil', acao: () => promptModal('Renomear som', 'Nome do som', s.name, (name) => send({ t: 'sound_edit', id: s.id, name })) },
    { rotulo: 'Trocar emoji', icone: 'smile-plus', acao: () => promptModal('Trocar emoji', 'Um emoji para o botão', s.emoji || '', (emoji) => send({ t: 'sound_edit', id: s.id, emoji })) },
    { rotulo: 'Remover', icone: 'trash-2', perigo: true, acao: () => confirmModal('Remover som?', `"${s.name}" sai do soundboard de todo mundo.`, () => send({ t: 'sound_delete', id: s.id })) },
  ]);
}

function menuTela(e, uid, local, tile, focar) {
  const u = S.users.find((x) => x.id === uid) || { id: uid, name: nameOf(uid) };
  const v = tile.querySelector('video');
  abrirMenu(e, [
    { titulo: local ? 'Sua tela' : 'Tela de ' + u.name },
    local ? { rotulo: 'Parar de compartilhar', icone: 'screen-share-off', perigo: true, acao: () => stopScreen() }
      : { rotulo: 'Parar de assistir', icone: 'eye-off', acao: () => assistir(uid, false) },
    local ? null : { no: controleVolume('Som da tela', volumeDe(u, 'tela'), (val) => definirVolume(u, 'tela', val)) },
    '-',
    { rotulo: tile.classList.contains('focused') ? 'Desfocar' : 'Focar', icone: 'maximize-2', acao: () => focar.click() },
    { rotulo: 'Tela cheia', icone: 'fullscreen', acao: () => tile.requestFullscreen() },
    document.pictureInPictureEnabled ? { rotulo: 'Janela flutuante', icone: 'picture-in-picture-2', acao: () => v.requestPictureInPicture().catch(() => toast('Não deu para abrir a janela flutuante.')) } : null,
  ]);
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
function closeModal() { $('#modal').classList.add('hidden'); $('#modalOk').disabled = false; $('#modalOk').classList.remove('hidden'); $('#modalBody').replaceChildren(); modalOk = modalCancel = null; }
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
// Não há "sair da voz" ao sair da página: esse evento também dispara em navegações que o app bloqueia
// (como clicar num arquivo), e tirava a pessoa da sala. Ao fechar o app, a conexão cai e o servidor já a tira.
showLogin();
if (LS.get('name') && LS.get('server') && LS.get('session')) $('#loginForm').requestSubmit();
