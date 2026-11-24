// DJAchat — cliente: áudio, voz (WebRTC), mudo, compartilhar tela e soundboard
// Os arquivos do cliente são scripts comuns carregados em ordem pelo index.html e dividem as mesmas variáveis globais.
'use strict';

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
