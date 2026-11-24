// DJAchat — cliente: canais, mensagens, lidas e menções, responder/reagir/editar, anexos
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
'use strict';

// ================================================================ canais
function renderChannels() {
  const tc = $('#textChannels'), vc = $('#voiceChannels'), dl = $('#dmList');
  tc.replaceChildren(); vc.replaceChildren(); dl.replaceChildren();
  for (const d of S.dms) {
    const row = el('div', 'chan dm');
    const online = S.users.find((u) => u.uid === d.outro);
    const av = el('div', 'avatar'); paintAvatar(av, { name: d.name, uid: d.outro, color: online ? online.color : null });
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
    const av = el('div', 'avatar'); paintAvatar(av, u); pontoStatus(av, u);
    const info = el('div', 'info-membro');
    info.append(el('div', null, u.name + (u.id === S.me?.id ? ' (você)' : '')));
    if (u.status && u.status.texto) info.append(el('div', 'muted small recado', u.status.texto));
    if (u.id !== S.me?.id && S.mutados.has(chavePessoa(u))) { const mu = ic('volume-x', 'mutado-por-mim'); mu.setAttribute('aria-label', 'mutado por você'); info.firstChild.append(' ', mu); }
    if (u.voice) { const ch = S.channels.find((c) => c.id === u.voice); const v = el('div', 'muted small na-voz'); v.append(ic('volume-2'), ch ? ch.name : 'voz'); info.append(v); }
    r.append(av, info);
    list.append(r);
  }
  paintSpeaking();
}

function paintAvatar(node, u) {
  const foto = u.foto || (u.uid && S.fotos[u.uid]);
  const cor = u.color || '#d8b45f';
  node.textContent = foto ? '' : (u.name || '?').trim().charAt(0).toUpperCase();
  node.style.background = foto && /^[a-f0-9]{16}$/.test(foto) ? `center / cover no-repeat url("${fileUrl(foto)}"), ${cor}` : cor;
}
// bolinha de status no canto do avatar
function pontoStatus(av, u) {
  const tipo = (u.status && u.status.tipo) || 'online';
  const p = el('span', 'ponto-status ' + tipo); p.title = { online: 'Online', ausente: 'Ausente', ocupado: 'Ocupado (sem avisos)' }[tipo];
  av.style.position = 'relative'; av.append(p);
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
  if (S.lacuna[S.current]) {
    const v = el('button', 'voltar-fim'); v.type = 'button'; v.append(ic('arrow-down-to-line'), 'Você está vendo mensagens antigas. Ir para as mais recentes');
    v.onclick = voltarAoFim;
    box.append(v);
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
    const av = el('div', 'avatar'); paintAvatar(av, { name: m.author, uid: m.uid, color: m.color }); left.append(av);
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
  if (m.fixada) {
    const f = el('span', 'marca-fixada'); f.append(ic('pin'), 'fixada'); f.title = 'Fixada por ' + m.fixada.por;
    body.append(f);
  }
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
