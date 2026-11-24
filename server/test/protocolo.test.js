// DJAchat — testes do protocolo do servidor (rode com: cd server && npm test)
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirServidor, conectar, entrar } = require('./ajuda');

let srv;
before(async () => { srv = await abrirServidor(); });
after(async () => { await srv.fechar(); });

test('senha errada é barrada', async () => {
  const c = await conectar(srv, 'Intruso', { senha: 'errada' });
  const e = await c.esperar('error');
  assert.equal(e.code, 'senha');
  c.fechar();
});

test('entrar devolve canais, você e a sessão', async () => {
  const a = await entrar(srv, 'Ana');
  assert.equal(a.me.name, 'Ana');
  assert.ok(a.welcome.channels.some((c) => c.id === 'geral'));
  assert.ok(a.welcome.session && a.welcome.token);
  // a sessão devolvida serve no lugar da senha
  const b = await conectar(srv, 'Ana2', { senha: '' });
  b.mandar({ t: 'hello', name: 'Ana2', session: a.welcome.session, chave: b.chave });
  assert.ok(await b.esperar('welcome'));
  a.fechar(); b.fechar();
});

test('o apelido fica com o primeiro código que o usou', async () => {
  const dono = await entrar(srv, 'Bruno');
  const outro = await conectar(srv, 'bruno');   // mesmo apelido, outro PC sem o código
  const e = await outro.esperar('error');
  assert.equal(e.code, 'apelido');
  const mesmo = await entrar(srv, 'Bruno', { chave: dono.chave });   // o mesmo código entra
  assert.equal(mesmo.me.uid, dono.me.uid);
  dono.fechar(); outro.fechar(); mesmo.fechar();
});

test('mensagem chega para todo mundo e fica no histórico', async () => {
  const a = await entrar(srv, 'Carla');
  const b = await entrar(srv, 'Davi');
  a.mandar({ t: 'msg', channel: 'geral', text: 'oi galera' });
  const m = await b.esperar('msg', (x) => x.message.text === 'oi galera');
  assert.equal(m.message.author, 'Carla');
  b.mandar({ t: 'history', channel: 'geral' });
  const h = await b.esperar('history');
  assert.ok(h.messages.some((x) => x.id === m.message.id));
  a.fechar(); b.fechar();
});

test('mensagem vazia ou em canal que não existe é ignorada', async () => {
  const a = await entrar(srv, 'Edu');
  a.mandar({ t: 'msg', channel: 'geral', text: '   ' });
  a.mandar({ t: 'msg', channel: 'nao-existe', text: 'oi' });
  assert.ok(await a.naoRecebe('msg'));
  a.fechar();
});

test('mensagem direta só chega para os dois', async () => {
  const a = await entrar(srv, 'Fabi');
  const b = await entrar(srv, 'Gui');
  const c = await entrar(srv, 'Hugo');
  const dm = 'dm:' + [a.me.uid, b.me.uid].sort().join(':');
  a.mandar({ t: 'msg', channel: dm, text: 'segredo' });
  await b.esperar('msg', (x) => x.message.text === 'segredo');
  await b.esperar('dms', (x) => x.dms.some((d) => d.id === dm));
  assert.ok(await c.naoRecebe('msg', (x) => x.message.text === 'segredo'));
  c.mandar({ t: 'history', channel: dm });
  assert.ok(await c.naoRecebe('history', (x) => x.channel === dm));
  a.fechar(); b.fechar(); c.fechar();
});

test('só o autor edita ou apaga a própria mensagem', async () => {
  const a = await entrar(srv, 'Iara');
  const b = await entrar(srv, 'João');
  a.mandar({ t: 'msg', channel: 'geral', text: 'original' });
  const { message } = await b.esperar('msg', (x) => x.message.text === 'original');
  b.mandar({ t: 'msg_edit', channel: 'geral', id: message.id, text: 'hackeado' });
  b.mandar({ t: 'msg_delete', channel: 'geral', id: message.id });
  assert.ok(await a.naoRecebe('msg_update'));
  assert.ok(await a.naoRecebe('msg_delete'));
  a.mandar({ t: 'msg_edit', channel: 'geral', id: message.id, text: 'editada' });
  const up = await b.esperar('msg_update', (x) => x.message.id === message.id);
  assert.equal(up.message.text, 'editada');
  a.mandar({ t: 'msg_delete', channel: 'geral', id: message.id });
  await b.esperar('msg_delete', (x) => x.id === message.id);
  a.fechar(); b.fechar();
});

test('reação liga e desliga', async () => {
  const a = await entrar(srv, 'Kaio');
  a.mandar({ t: 'msg', channel: 'geral', text: 'reaja' });
  const { message } = await a.esperar('msg', (x) => x.message.text === 'reaja');
  a.mandar({ t: 'reagir', channel: 'geral', id: message.id, emoji: '👍' });
  let up = await a.esperar('msg_update');
  assert.deepEqual(up.message.reacoes['👍'], [a.me.uid]);
  a.mandar({ t: 'reagir', channel: 'geral', id: message.id, emoji: '👍' });
  up = await a.esperar('msg_update');
  assert.equal(up.message.reacoes['👍'], undefined);
  a.fechar();
});

test('criar, renomear e apagar canal', async () => {
  const a = await entrar(srv, 'Lia');
  a.mandar({ t: 'channel_create', name: 'Jogos Novos', kind: 'text' });
  const cr = await a.esperar('channels', (x) => x.channels.some((c) => c.name === 'jogos-novos'));
  const ch = cr.channels.find((c) => c.name === 'jogos-novos');
  a.mandar({ t: 'channel_rename', id: ch.id, name: 'jogos' });
  await a.esperar('channels', (x) => x.channels.some((c) => c.id === ch.id && c.name === 'jogos'));
  a.mandar({ t: 'channel_delete', id: ch.id });
  await a.esperar('channels', (x) => !x.channels.some((c) => c.id === ch.id));
  a.fechar();
});

test('entrar na voz avisa a sala e repassa a sinalização', async () => {
  const a = await entrar(srv, 'Mia');
  const b = await entrar(srv, 'Nico');
  a.mandar({ t: 'voice_join', channel: 'voz-1' });
  await a.esperar('voice_joined', (x) => x.peers.length === 0);
  b.mandar({ t: 'voice_join', channel: 'voz-1' });
  const j = await b.esperar('voice_joined');
  assert.deepEqual(j.peers, [a.me.id]);
  b.mandar({ t: 'signal', to: a.me.id, data: { teste: 1 } });
  const s = await a.esperar('signal');
  assert.equal(s.from, b.me.id);
  b.mandar({ t: 'voice_leave' });
  await a.esperar('peer_left', (x) => x.id === b.me.id);
  a.fechar(); b.fechar();
});

test('upload e download de arquivo exigem o token', async () => {
  const a = await entrar(srv, 'Olga');
  const semToken = await fetch(`${srv.base}/api/upload?kind=file`, { method: 'POST', body: 'x' });
  assert.equal(semToken.status, 401);
  const r = await fetch(`${srv.base}/api/upload?kind=file`, {
    method: 'POST', body: 'conteúdo de teste',
    headers: { 'x-token': a.welcome.token, 'x-filename': encodeURIComponent('nota.txt'), 'content-type': 'text/plain' },
  });
  assert.equal(r.status, 200);
  const f = await r.json();
  a.mandar({ t: 'msg', channel: 'geral', text: '', attachments: [{ id: f.id }] });
  await a.esperar('msg', (x) => x.message.attachments.length === 1);
  assert.equal((await fetch(`${srv.base}/files/${f.id}`)).status, 401);
  const d = await fetch(`${srv.base}/files/${f.id}?t=${a.welcome.token}`);
  assert.equal(d.status, 200);
  assert.equal(await d.text(), 'conteúdo de teste');
  a.fechar();
});

test('mensagens antigas vêm em páginas', async () => {
  const a = await entrar(srv, 'Paulo');
  a.mandar({ t: 'channel_create', name: 'paginas', kind: 'text' });
  const ch = (await a.esperar('channels', (x) => x.channels.some((c) => c.name === 'paginas'))).channels.find((c) => c.name === 'paginas');
  for (let i = 1; i <= 230; i++) a.mandar({ t: 'msg', channel: ch.id, text: 'n' + i });
  await a.esperar('msg', (x) => x.message.text === 'n230', 5000);
  a.mandar({ t: 'history', channel: ch.id });
  const p1 = await a.esperar('history', (x) => x.channel === ch.id);
  assert.equal(p1.messages.length, 100);
  assert.equal(p1.messages[0].text, 'n131');
  assert.equal(p1.mais, true);
  a.mandar({ t: 'history', channel: ch.id, antes: p1.messages[0].id });
  const p2 = await a.esperar('history', (x) => x.antes === p1.messages[0].id);
  assert.equal(p2.messages[0].text, 'n31');
  assert.equal(p2.messages[99].text, 'n130');
  a.mandar({ t: 'history', channel: ch.id, antes: p2.messages[0].id });
  const p3 = await a.esperar('history', (x) => x.antes === p2.messages[0].id);
  assert.equal(p3.messages.length, 30);
  assert.equal(p3.mais, false);
  // ao entrar de novo, o app sabe qual foi a última mensagem do canal
  const b = await entrar(srv, 'Paulo', { chave: a.chave });
  assert.equal(b.welcome.ultimas[ch.id].uid, a.me.uid);
  a.fechar(); b.fechar();
});
