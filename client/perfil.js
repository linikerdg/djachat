// DJAchat — cliente: status e foto de perfil
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
'use strict';

// ================================================================ status e foto de perfil
const meuTipo = () => (S.me && S.me.status && S.me.status.tipo) || 'online';
const ocupado = () => meuTipo() === 'ocupado';
function definirStatus(tipo, texto) {
  if (!S.me.uid) return toast('Atualize o DJAchat para usar status.');
  send({ t: 'perfil', status: { tipo, texto: texto === undefined ? ((S.me.status && S.me.status.texto) || '') : texto } });
}
function mostrarMeuStatus() {
  const st = S.me.status;
  $('#userPanel .me-name span').textContent = st && st.texto ? st.texto : { online: 'online', ausente: 'ausente', ocupado: 'ocupado' }[meuTipo()];
  const av = $('#meAvatar'); av.querySelectorAll('.ponto-status').forEach((p) => p.remove()); pontoStatus(av, S.me);
}
// sem mexer no mouse e no teclado por 10 minutos: ausente (volta sozinho).
// O servidor guarda que foi automático (status.auto), então volta mesmo depois de reiniciar o app
// ou se a pessoa voltou por outro PC. Cada PC manda o "ausente" uma vez só por período parado.
let ultimoMovimento = Date.now(), avisouParado = false;
const ausenteAuto = () => !!(S.me && S.me.status && S.me.status.tipo === 'ausente' && S.me.status.auto);
for (const ev of ['mousemove', 'keydown', 'mousedown', 'wheel']) {
  window.addEventListener(ev, () => {
    ultimoMovimento = Date.now(); avisouParado = false;
    if (S.connected && S.me && S.me.uid && ausenteAuto()) {
      S.me.status = { ...S.me.status, auto: false };   // não manda de novo até o servidor responder
      send({ t: 'perfil', status: { tipo: 'online', texto: S.me.status.texto || '' } });
    }
  }, { passive: true });
}
setInterval(() => {
  if (!S.connected || !S.me || !S.me.uid || meuTipo() !== 'online' || S.voice || avisouParado) return;
  if (Date.now() - ultimoMovimento > 10 * 60000) { avisouParado = true; send({ t: 'perfil', status: { tipo: 'ausente', texto: (S.me.status && S.me.status.texto) || '', auto: true } }); }
}, 30000);

// a foto vira um quadrado de 256 px antes de subir (fica leve para todo mundo)
async function escolherFoto() {
  const inp = el('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/gif,image/webp';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const lado = Math.min(bmp.width, bmp.height), t = 256;
      const c = document.createElement('canvas'); c.width = c.height = t;
      c.getContext('2d').drawImage(bmp, (bmp.width - lado) / 2, (bmp.height - lado) / 2, lado, lado, 0, 0, t, t);
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
      const arq = new File([blob], 'foto.webp', { type: 'image/webp' });
      const enviado = await enviarArquivo(arq);
      send({ t: 'perfil', foto: enviado.id });
      toast('Foto trocada');
    } catch (e) { toast('Não consegui usar essa imagem: ' + e.message); }
  };
  inp.click();
}

// ================================================================ cartão de perfil (nome e foto no chat)
// A pessoa de uma mensagem: online, com o status de agora; senão, só o que a mensagem diz
function pessoaDaMensagem(m) {
  const online = S.users.find((u) => (m.uid && u.uid === m.uid) || (!m.uid && u.name === m.author));
  if (online) return { ...online, online: true };
  return { name: m.author, uid: m.uid || null, color: m.color, foto: m.uid ? S.fotos[m.uid] : null, online: false };
}

let cartaoAberto = null, cartaoFixo = false, cartaoTimer = null, cartaoAncora = null;
function fecharCartao() {
  clearTimeout(cartaoTimer);
  if (cartaoAberto) { cartaoAberto.remove(); cartaoAberto = null; }
  cartaoFixo = false; cartaoAncora = null;
}
function abrirCartao(ancora, u, fixo) {
  if (cartaoAberto && cartaoAncora === ancora) { if (fixo) cartaoFixo = true; return; }
  fecharCartao();
  const eu = S.me && ((u.uid && u.uid === S.me.uid) || u.id === S.me.id);
  const c = el('div', 'cartao-perfil');
  const topo = el('div', 'topo');
  const av = el('div', 'avatar'); paintAvatar(av, u);
  if (u.online) pontoStatus(av, u);
  const nome = el('b', null, u.name); nome.style.color = u.color || '';
  topo.append(av, nome);
  c.append(topo);
  const tipo = (u.status && u.status.tipo) || 'online';
  const linha = el('div', 'estado muted small', u.online ? { online: 'Online', ausente: 'Ausente', ocupado: 'Ocupado' }[tipo] : 'Offline');
  c.append(linha);
  if (u.online && u.status && u.status.texto) c.append(el('div', 'recado', u.status.texto));
  if (u.online && u.voice) {
    const sala = canalInfo(u.voice);
    const v = el('div', 'na-voz small'); v.append(ic('volume-2'), 'Na sala ' + (sala ? sala.name : 'de voz'));
    c.append(v);
  }
  const acoes = el('div', 'acoes');
  const botao = (rotulo, icone, acao) => { const b = el('button'); b.type = 'button'; rotular(b, icone, rotulo); b.onclick = () => { fecharCartao(); acao(); }; acoes.append(b); };
  if (eu) botao('Editar perfil', 'settings', () => $('#btnSettings').click());
  else {
    if (u.uid && S.me.uid) botao('Mensagem direta', 'message-square', () => abrirDm(u));
    botao('Mencionar', 'at-sign', () => mencionar(u.name));
  }
  c.append(acoes);
  c.addEventListener('mousedown', (e) => e.stopPropagation());
  c.onmouseenter = () => clearTimeout(cartaoTimer);
  c.onmouseleave = () => { if (!cartaoFixo) cartaoTimer = setTimeout(fecharCartao, 250); };
  document.body.append(c);
  // ao lado do nome/foto, sem sair da tela
  const r = ancora.getBoundingClientRect();
  const w = c.offsetWidth, h = c.offsetHeight;
  const x = r.right + 8 + w <= innerWidth - 6 ? r.right + 8 : r.left - w - 8;
  c.style.left = Math.max(6, Math.min(x, innerWidth - w - 6)) + 'px';
  c.style.top = Math.max(6, Math.min(r.top, innerHeight - h - 6)) + 'px';
  cartaoAberto = c; cartaoFixo = !!fixo; cartaoAncora = ancora;
}
// clique: abre e fica; mouse parado por meio segundo: prévia que some ao sair
function ligarCartaoPerfil(alvo, pessoa) {
  alvo.classList.add('clicavel');
  alvo.onclick = (e) => { e.stopPropagation(); abrirCartao(alvo, pessoa(), true); };
  alvo.onmouseenter = () => {
    clearTimeout(cartaoTimer);
    if (cartaoAberto && cartaoAncora === alvo) return;
    cartaoTimer = setTimeout(() => abrirCartao(alvo, pessoa(), false), 600);
  };
  alvo.onmouseleave = () => {
    clearTimeout(cartaoTimer);
    if (cartaoAberto && !cartaoFixo) cartaoTimer = setTimeout(fecharCartao, 250);
  };
}
document.addEventListener('mousedown', () => { if (cartaoAberto) fecharCartao(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharCartao(); });
$('#messages').addEventListener('scroll', () => { if (cartaoAberto) fecharCartao(); });
