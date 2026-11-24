// DJAchat — cliente: configurações e a janela do app desktop
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
'use strict';

// ================================================================ configurações
$('#btnSettings').onclick = async () => {
  let devices = [];
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* */ }
  const body = el('div');
  // perfil: foto e status
  const perfil = el('div', 'perfil');
  const avP = el('div', 'avatar grande'); paintAvatar(avP, S.me);
  const bFoto = el('button'); bFoto.type = 'button'; rotular(bFoto, 'image-plus', 'Trocar foto'); bFoto.onclick = escolherFoto;
  const bSemFoto = el('button'); bSemFoto.type = 'button'; rotular(bSemFoto, 'x', 'Tirar foto'); bSemFoto.onclick = () => send({ t: 'perfil', foto: null });
  const botoesFoto = el('div', 'row'); botoesFoto.append(bFoto, bSemFoto);
  const ladoP = el('div'); ladoP.append(el('b', null, S.me.name), botoesFoto);
  perfil.append(avP, ladoP);
  if (!S.me.uid) perfil.classList.add('hidden');
  body.append(el('label', null, 'Seu perfil'), perfil);
  const stSel = el('select');
  for (const [v, t] of [['online', 'Online'], ['ausente', 'Ausente'], ['ocupado', 'Ocupado (sem sons de mensagem)']]) stSel.append(new Option(t, v));
  stSel.value = meuTipo();
  const stL = el('label', null, 'Status'); stL.append(stSel);
  const recado = el('input'); recado.maxLength = 60; recado.placeholder = 'Recado (ex.: jogando Valheim)'; recado.value = (S.me.status && S.me.status.texto) || '';
  const rcL = el('label', null, 'Recado'); rcL.append(recado);
  if (S.me.uid) body.append(stL, rcL);
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
    if (S.me.uid && (stSel.value !== meuTipo() || recado.value.trim() !== ((S.me.status && S.me.status.texto) || ''))) definirStatus(stSel.value, recado.value.trim());
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
// ---------------------------------------------------------------- atualização automática
// O app desktop baixa a versão nova sozinho; aqui só aparece o aviso para reiniciar.
function avisoAtualizacao(versao) {
  if (!versao || document.querySelector('#avisoAtualizacao')) return;
  const a = el('div'); a.id = 'avisoAtualizacao';
  const txt = el('span'); txt.append('Versão ', el('b', null, versao), ' do DJAchat baixada.');
  const agora = el('button', 'primary'); agora.type = 'button'; rotular(agora, 'refresh-cw', 'Reiniciar e atualizar');
  agora.onclick = () => {
    const ir = () => desktop.instalarAtualizacao();
    if (S.voice) confirmModal('Reiniciar agora?', 'Você sai da sala de voz por alguns segundos enquanto o app atualiza.', ir); else ir();
  };
  const depois = el('button'); depois.type = 'button'; depois.textContent = 'Depois';
  depois.title = 'Atualiza sozinho quando você fechar o DJAchat';
  depois.onclick = () => a.remove();
  a.append(txt, agora, depois);
  document.body.append(a);
}
if (desktop && desktop.aoAtualizar) {
  desktop.aoAtualizar((info) => avisoAtualizacao(info.versao));
  desktop.versao().then((v) => { S.versaoApp = v.atual; avisoAtualizacao(v.pronta); }).catch(() => {});
}

function opcoesDaJanela() {
  const w = el('div', 'janela-opcoes');
  w.append(el('label', null, 'Janela e app' + (S.versaoApp ? ' · versão ' + S.versaoApp : '')));
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
