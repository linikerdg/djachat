// DJAchat — cliente: menus de clique direito, janelas (modal) e avisos (toast)
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
'use strict';

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
    { titulo: 'Status' },
    ...['online', 'ausente', 'ocupado'].map((tipo) => ({ rotulo: { online: 'Online', ausente: 'Ausente', ocupado: 'Ocupado (sem avisos)' }[tipo] + (meuTipo() === tipo ? '  ✓' : ''), icone: tipo === 'ocupado' ? 'bell-off' : tipo === 'ausente' ? 'eye-off' : 'check-check', acao: () => definirStatus(tipo) })),
    { rotulo: 'Escrever um recado…', icone: 'pencil', acao: () => promptModal('Recado', 'Aparece embaixo do seu nome (ex.: jogando Valheim)', (S.me.status && S.me.status.texto) || '', (t) => definirStatus(meuTipo(), t)) },
    S.me.status && S.me.status.texto ? { rotulo: 'Apagar recado', icone: 'x', acao: () => definirStatus(meuTipo(), '') } : null,
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
    const mais = el('button', null); mais.type = 'button'; mais.title = 'Outro emoji'; mais.append(ic('smile-plus'));
    mais.onclick = () => { const r = mais.getBoundingClientRect(); fecharMenu(); abrirSeletorEmoji({ x: r.left, y: r.top, getBoundingClientRect: () => r }, (e) => reagir(m, e)); };
    reacoes.append(mais);
  }
  return [
    reacoes ? { no: reacoes } : null,
    { rotulo: 'Responder', icone: 'reply', acao: () => responder(m) },
    sel ? { rotulo: 'Copiar seleção', icone: 'copy', acao: () => copiarTexto(sel) } : null,
    m.text ? { rotulo: 'Copiar texto', icone: 'copy', acao: () => copiarTexto(m.text) } : null,
    { rotulo: 'Mencionar ' + m.author, icone: 'at-sign', acao: () => mencionar(m.author) },
    { rotulo: m.fixada ? 'Desafixar' : 'Fixar mensagem', icone: m.fixada ? 'pin-off' : 'pin', acao: () => send({ t: 'fixar', channel: m.channel, id: m.id, fixar: !m.fixada }) },
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
