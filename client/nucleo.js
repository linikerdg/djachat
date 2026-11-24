// DJAchat — cliente: estado, conexão com o servidor, mensagens que chegam e login
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
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
  fotos: {},               // uid -> id do arquivo da foto de perfil
  lacuna: {},              // channelId -> true quando a lista aberta é um trecho antigo (busca, fixada)
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
const canalInfo = (id) => S.channels.find((c) => c.id === id) || S.dms.find((d) => d.id === id) || subchatInfo(id);
// um subchat parece um canal para o resto do app (kind 'subchat', name)
function subchatInfo(id) { const sc = (S.subchats || []).find((x) => x.id === id); return sc ? { ...sc, kind: 'subchat', name: sc.nome } : null; }
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
      if (S.painel === 'fixadas' && m.message.channel === S.current) send({ t: 'fixadas', channel: S.current });
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
      S.channels = m.channels; S.sounds = m.sounds; S.users = m.users; S.dms = m.dms || []; S.hospedavel = !!m.hospedavel; S.subchats = m.subchats || [];
      $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
      $('#connDot').className = 'dot ok'; $('#connDot').title = 'Conectado';
      $('#meName').textContent = S.me.name; paintAvatar($('#meAvatar'), S.me);
      S.messages = {}; S.loaded = new Set(); S.mais = {}; S.lacuna = {}; S.fotos = m.fotos || {};
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
      const eu = S.users.find((u) => u.id === S.me.id);
      if (eu) { S.me = eu; paintAvatar($('#meAvatar'), eu); mostrarMeuStatus(); }
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
      // vendo um trecho antigo: a nova não entra na lista (ela aparece ao voltar para as mais recentes)
      const lacuna = S.lacuna[msg.channel];
      if (!lacuna) (S.messages[msg.channel] ||= []).push(msg);
      if (S.typing[msg.channel]) delete S.typing[msg.channel][msg.authorId];
      const vendo = !lacuna && msg.channel === S.current && S.view === 'text';
      const mencao = !souEu(msg) && mencionaNome(msg.text, S.me.name);
      if (vendo) { appendMessage(msg); if (document.hasFocus()) marcarLido(msg.channel); }
      if (!souEu(msg) && !vendo) {
        S.unread.add(msg.channel);
        if (mencao) S.mencoes[msg.channel] = (S.mencoes[msg.channel] || 0) + 1;
        renderChannels();
      }
      // menção toca mesmo em canal silenciado
      if (!souEu(msg) && !ocupado() && (mencao || !S.silenciados.has(msg.channel)) && (!document.hasFocus() || msg.channel !== S.current)) {
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
    case 'fotos':
      S.fotos = m.fotos;
      paintAvatar($('#meAvatar'), S.me); mostrarMeuStatus();
      if (S.view === 'text') renderMessages(true);
      break;
    case 'subchats':
      S.subchats = m.subchats;
      // o subchat aberto foi apagado: volta para a conversa de onde ele veio
      if (S.current && S.current.startsWith('sc:') && !canalInfo(S.current)) {
        const volta = canalInfo(LS.get('lastChannel')) && !String(LS.get('lastChannel')).startsWith('sc:') ? LS.get('lastChannel') : (S.channels.find((c) => c.kind === 'text') || {}).id;
        if (volta) openText(volta);
      }
      renderSubchats();
      if (S.current && S.current.startsWith('sc:') && canalInfo(S.current)) $('#chanTitle').replaceChildren(ic('messages-square'), canalInfo(S.current).name);   // nome novo no topo
      break;
    case 'subchat_criado': openText(m.id); break;
    case 'resultados': mostrarResultados(m); break;
    case 'fixadas': if (m.channel === S.current) mostrarFixadas(m.messages); break;
    case 'cercanias': {
      // um trecho antigo da conversa, em volta da mensagem procurada
      S.messages[m.channel] = m.messages;
      S.mais[m.channel] = !!m.mais;
      S.lacuna[m.channel] = !!m.depois;
      S.loaded.add(m.channel);
      if (m.channel === S.current && S.view === 'text') { renderMessages(true); irPara(m.id); }
      break;
    }
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
