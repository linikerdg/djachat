// DJAchat — cliente: busca, mensagens fixadas e emojis na caixa de mensagem
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
'use strict';

// ================================================================ busca e mensagens fixadas
function abrirPainel(titulo) {
  $('#painelTitulo').textContent = titulo;
  $('#painel').classList.remove('hidden');
  return $('#painelLista');
}
function fecharPainel() { $('#painel').classList.add('hidden'); $('#painelLista').replaceChildren(); S.painel = null; }
$('#painelFechar').onclick = fecharPainel;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.painel && !menuAberto && !seletorAberto) fecharPainel();
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f' && S.me) { e.preventDefault(); $('#busca').focus(); $('#busca').select(); }
});
$('#busca').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const t = $('#busca').value.trim();
    if (t.length < 2) return toast('Digite pelo menos 2 letras');
    S.painel = 'busca';
    abrirPainel('Buscando…').replaceChildren(el('div', 'muted small vazio', 'Procurando em todas as conversas…'));
    send({ t: 'buscar', texto: t });
  } else if (e.key === 'Escape') { $('#busca').value = ''; $('#busca').blur(); }
});
$('#btnFixadas').onclick = () => {
  if (S.painel === 'fixadas') return fecharPainel();
  if (!S.current) return;
  S.painel = 'fixadas';
  abrirPainel('Fixadas').replaceChildren(el('div', 'muted small vazio', 'Carregando…'));
  send({ t: 'fixadas', channel: S.current });
};
function nomeDoCanal(id) {
  const c = canalInfo(id);
  return c ? (c.kind === 'dm' ? '@' + c.name : '#' + c.name) : '?';
}
// um cartão de mensagem para o painel; clicar leva até ela
function cartaoMensagem(canal, m) {
  const c = el('button', 'cartao'); c.type = 'button';
  const topo = el('div', 'topo');
  const av = el('div', 'avatar'); paintAvatar(av, { name: m.author, uid: m.uid, color: m.color });
  const quem = el('b', null, m.author); quem.style.color = m.color;
  const d = new Date(m.ts);
  topo.append(av, quem, el('span', 'muted small', nomeDoCanal(canal) + ' · ' + d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })));
  const t = el('div', 'texto');
  if (m.text) formatar(t, m.text.length > 300 ? m.text.slice(0, 300) + '…' : m.text, { nomes: nomesConhecidos(), meuNome: S.me.name });
  else if (m.attachments && m.attachments.length) t.append(el('span', 'muted', '📎 ' + m.attachments.map((a) => a.name).join(', ')));
  c.append(topo, t);
  c.onclick = () => irParaMensagem(canal, m.id);
  return c;
}
function mostrarResultados(r) {
  if (S.painel !== 'busca') return;
  const lista = abrirPainel(r.total ? `${r.total} resultado${r.total > 1 ? 's' : ''}` + (r.total > r.itens.length ? ` (os ${r.itens.length} mais novos)` : '') : 'Nada encontrado');
  lista.replaceChildren();
  if (!r.itens.length) lista.append(el('div', 'muted small vazio', `Nenhuma mensagem com "${r.texto}".`));
  for (const it of r.itens) lista.append(cartaoMensagem(it.channel, it.message));
}
function mostrarFixadas(msgs) {
  if (S.painel !== 'fixadas') return;
  const lista = abrirPainel('Fixadas em ' + nomeDoCanal(S.current));
  lista.replaceChildren();
  if (!msgs.length) lista.append(el('div', 'muted small vazio', 'Nenhuma mensagem fixada aqui. Clique com o botão direito numa mensagem → Fixar.'));
  for (const m of msgs) lista.append(cartaoMensagem(m.channel, m));
}
// abre o canal e rola até a mensagem; se ela não estiver carregada, pede o trecho em volta dela
function irParaMensagem(canal, id) {
  if (S.current !== canal || S.view !== 'text') openText(canal);
  const l = S.messages[canal];
  if (l && l.some((x) => x.id === id)) return irPara(id);
  send({ t: 'cercanias', channel: canal, id });
}
function voltarAoFim() {
  S.lacuna[S.current] = false;
  S.loaded.delete(S.current);
  send({ t: 'history', channel: S.current });
}

// ================================================================ emojis na caixa de mensagem
$('#btnEmoji').onclick = () => abrirSeletorEmoji($('#btnEmoji'), (e) => {
  const ini = input.selectionStart ?? input.value.length, fim = input.selectionEnd ?? ini;
  input.value = input.value.slice(0, ini) + e + input.value.slice(fim);
  input.focus(); input.setSelectionRange(ini + e.length, ini + e.length);
  input.dispatchEvent(new Event('input'));
});
