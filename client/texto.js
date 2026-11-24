// DJAchat — texto das mensagens: formatação, links e menções.
// Monta tudo com nós do DOM (textContent), nunca com HTML: o que alguém digita não vira código.
//
//   **negrito**   *itálico* ou _itálico_   ~~riscado~~   ||spoiler||   `código`
//   ```bloco de código```   > citação (no começo da linha)   @apelido   @todos
'use strict';

const MENCAO_TODOS = ['todos', 'everyone', 'here', 'aqui'];

const escaparRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Expressão que acha @nome para qualquer um dos nomes (o mais comprido primeiro, para "Ana Maria" ganhar de "Ana")
function reMencoes(nomes) {
  const lista = [...new Set([...nomes, ...MENCAO_TODOS].filter(Boolean))].sort((a, b) => b.length - a.length).map(escaparRe);
  return new RegExp(`@(${lista.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

// A mensagem chama esta pessoa (pelo apelido ou com @todos)?
function mencionaNome(texto, nome) {
  if (!texto || !nome) return false;
  return reMencoes([nome]).test(texto);
}

// Texto simples: links clicáveis e menções destacadas
function textoSimples(no, texto, ctx) {
  const partes = [];
  const reLink = /https?:\/\/[^\s<]+[^\s<.,:;!?"')\]]/g;
  let m;
  while ((m = reLink.exec(texto))) partes.push({ i: m.index, f: m.index + m[0].length, tipo: 'link', v: m[0] });
  if (ctx.reMencao) {
    ctx.reMencao.lastIndex = 0;
    while ((m = ctx.reMencao.exec(texto))) {
      if (!partes.some((p) => m.index < p.f && m.index + m[0].length > p.i)) partes.push({ i: m.index, f: m.index + m[0].length, tipo: 'mencao', v: m[0], nome: m[1] });
    }
  }
  partes.sort((a, b) => a.i - b.i);
  let ultimo = 0;
  for (const p of partes) {
    no.append(texto.slice(ultimo, p.i));
    if (p.tipo === 'link') {
      const a = el('a', null, p.v); a.href = p.v; a.target = '_blank'; a.rel = 'noreferrer';
      no.append(a);
    } else {
      const eu = ctx.meuNome && p.nome.toLowerCase() === ctx.meuNome.toLowerCase();
      const todos = MENCAO_TODOS.includes(p.nome.toLowerCase());
      no.append(el('span', 'mencao' + (eu || todos ? ' eu' : ''), p.v));
    }
    ultimo = p.f;
  }
  no.append(texto.slice(ultimo));
}

// Marcas em linha. A ordem importa: ** antes de *, e código não tem nada dentro.
const MARCAS = [
  { abre: '`', classe: 'codigo', cru: true },
  { abre: '**', tag: 'b' },
  { abre: '~~', tag: 's' },
  { abre: '||', classe: 'spoiler' },
  { abre: '*', tag: 'i', palavra: true },   // *assim*, mas 2*3*4 fica como está
  { abre: '_', tag: 'i', palavra: true },   // _assim_, mas não no meio de nomes_com_traço
];

function emLinha(no, texto, ctx) {
  let i = 0, livre = 0;
  while (i < texto.length) {
    let achou = null;
    for (const mk of MARCAS) {
      if (!texto.startsWith(mk.abre, i)) continue;
      if (mk.palavra && i > 0 && /[\p{L}\p{N}]/u.test(texto[i - 1])) continue;
      const ini = i + mk.abre.length;
      let fim = texto.indexOf(mk.abre, ini);
      // "**" não fecha um "*" aberto, e vice-versa
      while (mk.abre === '*' && fim >= 0 && texto[fim + 1] === '*') fim = texto.indexOf('*', fim + 2);
      if (fim <= ini || /^\s|\s$/.test(texto.slice(ini, fim)) && !mk.cru) continue;
      if (mk.palavra && /[\p{L}\p{N}]/u.test(texto[fim + 1] || '')) continue;
      achou = { mk, ini, fim };
      break;
    }
    if (!achou) { i++; continue; }
    if (i > livre) textoSimples(no, texto.slice(livre, i), ctx);
    const { mk, ini, fim } = achou;
    const dentro = texto.slice(ini, fim);
    const n = el(mk.tag || 'span', mk.classe || null);
    if (mk.cru) n.textContent = dentro; else emLinha(n, dentro, ctx);
    if (mk.classe === 'spoiler') { n.title = 'Clique para ver'; n.onclick = () => n.classList.add('visto'); }
    no.append(n);
    i = livre = fim + mk.abre.length;
  }
  if (livre < texto.length) textoSimples(no, texto.slice(livre), ctx);
}

// Linhas: "> " no começo vira citação
function blocoDeLinhas(no, texto, ctx) {
  const linhas = texto.split('\n');
  let citacao = null;
  linhas.forEach((linha, k) => {
    const cit = /^>\s?(.*)$/.exec(linha);
    if (cit) {
      if (!citacao) { citacao = el('div', 'citacao'); no.append(citacao); } else citacao.append('\n');
      emLinha(citacao, cit[1], ctx);
      return;
    }
    if (citacao) { citacao = null; if (!linha) return; } else if (k > 0) no.append('\n');
    emLinha(no, linha, ctx);
  });
}

// Ponto de entrada. ctx: { nomes: [...apelidos conhecidos], meuNome }
function formatar(no, texto, ctx = {}) {
  const c = { ...ctx, reMencao: ctx.nomes && ctx.nomes.length ? reMencoes(ctx.nomes) : reMencoes([]) };
  const reBloco = /```(?:[a-z0-9]*\n)?([\s\S]*?)```/g;
  let ultimo = 0, m;
  while ((m = reBloco.exec(texto))) {
    if (m.index > ultimo) blocoDeLinhas(no, texto.slice(ultimo, m.index).replace(/\n$/, ''), c);
    no.append(el('pre', 'bloco-codigo', m[1].replace(/\n$/, '')));
    ultimo = m.index + m[0].length;
    if (texto[ultimo] === '\n') ultimo++;
  }
  if (ultimo < texto.length) blocoDeLinhas(no, texto.slice(ultimo), c);
}

// para os testes (node): sem DOM, só as funções puras
if (typeof module !== 'undefined') module.exports = { reMencoes, mencionaNome, MENCAO_TODOS };
