// DJAchat — cliente: status e foto de perfil
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
'use strict';

// ================================================================ status e foto de perfil
const meuTipo = () => (S.me && S.me.status && S.me.status.tipo) || 'online';
const ocupado = () => meuTipo() === 'ocupado';
function definirStatus(tipo, texto) {
  if (!S.me.uid) return toast('Atualize o DJAchat para usar status.');
  S.ausenteAutomatico = false;
  send({ t: 'perfil', status: { tipo, texto: texto === undefined ? ((S.me.status && S.me.status.texto) || '') : texto } });
}
function mostrarMeuStatus() {
  const st = S.me.status;
  $('#userPanel .me-name span').textContent = st && st.texto ? st.texto : { online: 'online', ausente: 'ausente', ocupado: 'ocupado' }[meuTipo()];
  const av = $('#meAvatar'); av.querySelectorAll('.ponto-status').forEach((p) => p.remove()); pontoStatus(av, S.me);
}
// sem mexer no mouse e no teclado por 10 minutos: ausente (volta sozinho)
let ultimoMovimento = Date.now();
for (const ev of ['mousemove', 'keydown', 'mousedown', 'wheel']) {
  window.addEventListener(ev, () => {
    ultimoMovimento = Date.now();
    if (S.ausenteAutomatico && S.connected) { S.ausenteAutomatico = false; send({ t: 'perfil', status: { tipo: 'online', texto: (S.me.status && S.me.status.texto) || '' } }); }
  }, { passive: true });
}
setInterval(() => {
  if (!S.connected || !S.me || !S.me.uid || meuTipo() !== 'online' || S.voice) return;
  if (Date.now() - ultimoMovimento > 10 * 60000) { S.ausenteAutomatico = true; send({ t: 'perfil', status: { tipo: 'ausente', texto: (S.me.status && S.me.status.texto) || '' } }); }
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
