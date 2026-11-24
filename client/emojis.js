// DJAchat — seletor de emojis (caixa de mensagem e reações)
'use strict';

const EMOJIS = {
  'Carinhas': '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😮‍💨🤥😌😔😪🤤😴😷🤒🤕🤢🤮🥵🥶🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠️💩🤡👹👺👻👽👾🤖',
  'Gestos': '👋🤚🖐️✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆🖕👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍️💪🦾🧠👀👁️👅👄',
  'Corações': '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💯💢💥💫💦💨🕳️💬💭💤',
  'Coisas': '🔥⭐🌟✨⚡🎉🎊🎁🏆🥇🎮🕹️🎲🎯🎵🎶🎤🎧📢🔔🔕💡📌📎✂️🔒🔑🛡️⚔️🏹🪓⛏️🔨💣💰💎🍕🍔🍟🌭🍿🍩🍪🎂🍰🍫🍺🍻🥂🍷☕🧃',
  'Natureza': '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐔🐧🐦🦅🦉🐺🐗🐴🦄🐝🐛🦋🐌🐞🐢🐍🦎🐙🦑🦀🐟🐬🐳🦈🐊🐉🌵🌲🌳🌴🍀🍁🍂🌸🌹🌻🌞🌝🌚🌙⭐☀️⛅🌧️⛈️❄️☃️🌈🌊',
  'Símbolos': '✅❌❓❗‼️⁉️⚠️🚫⛔♻️✔️➕➖➗✖️🔴🟠🟡🟢🔵🟣⚫⚪🟥🟩🟦⬆️⬇️⬅️➡️🔄🔁🆗🆕🆒🆘',
};

// separa a string em emojis (alguns ocupam vários caracteres)
const separarEmojis = (() => {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }) : null;
  return (s) => (seg ? [...seg.segment(s)].map((x) => x.segment) : [...s]);
})();

let seletorAberto = null, ancoraAberta = null, fechadoEm = 0;
function fecharSeletorEmoji() { if (seletorAberto) { seletorAberto.remove(); seletorAberto = null; fechadoEm = Date.now(); } }

// Abre a grade perto de "ancora" (um elemento ou {x, y}); aoEscolher(emoji)
function abrirSeletorEmoji(ancora, aoEscolher) {
  // clicar de novo no mesmo botão fecha (o mousedown já fechou; aqui só não abre de novo)
  if (ancora === ancoraAberta && Date.now() - fechadoEm < 400) { ancoraAberta = null; return; }
  fecharSeletorEmoji();
  ancoraAberta = ancora;
  const caixa = el('div', 'seletor-emoji');
  const abas = el('div', 'abas');
  const grade = el('div', 'grade');
  const recentes = LS.get('emojisRecentes', []);
  const categorias = recentes.length ? { 'Recentes': recentes.join(''), ...EMOJIS } : EMOJIS;
  const mostrar = (nome) => {
    grade.replaceChildren();
    abas.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.cat === nome));
    for (const e of separarEmojis(categorias[nome])) {
      const b = el('button', null, e); b.type = 'button';
      b.onclick = () => {
        LS.set('emojisRecentes', [e, ...recentes.filter((x) => x !== e)].slice(0, 24));
        fecharSeletorEmoji();
        aoEscolher(e);
      };
      grade.append(b);
    }
    grade.scrollTop = 0;
  };
  for (const nome of Object.keys(categorias)) {
    const b = el('button', null, separarEmojis(categorias[nome])[0]); b.type = 'button'; b.title = nome; b.dataset.cat = nome;
    b.onclick = (e) => { e.stopPropagation(); mostrar(nome); };
    abas.append(b);
  }
  caixa.append(abas, grade);
  caixa.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.append(caixa);
  mostrar(Object.keys(categorias)[0]);
  // posição: acima da âncora, sem sair da tela
  const r = ancora.getBoundingClientRect ? ancora.getBoundingClientRect() : { left: ancora.x, top: ancora.y, right: ancora.x, bottom: ancora.y };
  const w = caixa.offsetWidth, h = caixa.offsetHeight;
  caixa.style.left = Math.max(6, Math.min(r.right - w, innerWidth - w - 6)) + 'px';
  caixa.style.top = Math.max(6, r.top - h - 8 < 6 ? r.bottom + 8 : r.top - h - 8) + 'px';
  seletorAberto = caixa;
}
document.addEventListener('mousedown', fecharSeletorEmoji);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharSeletorEmoji(); });
