// DJAchat — testes dos dados do grupo no OneDrive, com um OneDrive de mentira na memória
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarCompartilhado } = require('../compartilhado');

// Imita o que o servidor usa do onedrive.js: versões (etag) e gravação condicional
function oneDriveFalso() {
  const arquivos = new Map();   // caminho -> { texto, etag, modificado }
  let n = 0;
  const gravacoes = [];
  const conflito = () => Object.assign(new Error('conflito'), { codigo: 'conflito' });
  return {
    arquivos, gravacoes,
    async lerJson(p) {
      const a = arquivos.get(p);
      return a ? { dados: JSON.parse(a.texto), etag: a.etag, modificado: a.modificado, agora: Date.now() } : null;
    },
    async gravarJson(p, texto, { etag, criar } = {}) {
      const a = arquivos.get(p);
      if (criar && a) throw conflito();
      if (etag && (!a || a.etag !== etag)) throw conflito();
      const novo = { texto, etag: `e${++n}`, modificado: Date.now() };
      arquivos.set(p, novo);
      gravacoes.push(p);
      return { etag: novo.etag, modificado: novo.modificado, agora: Date.now() };
    },
    async apagarSeIgual(p, etag) { if (arquivos.get(p) && arquivos.get(p).etag === etag) arquivos.delete(p); },
    async apagarCaminho(p) { arquivos.delete(p); },
  };
}

const dbAntigo = () => ({
  channels: [{ id: 'geral', name: 'geral', kind: 'text' }, { id: 'memes', name: 'memes', kind: 'text' }],
  messages: { geral: [{ id: 'm1', text: 'oi' }], memes: [{ id: 'm2', text: 'kkk' }], 'dm:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb': [{ id: 'm3', text: 'psiu' }] },
  files: {}, sounds: [], contas: {}, apelidos: {}, versao: 7,
});

test('converte o formato antigo e envia só os canais que mudaram', async () => {
  const od = oneDriveFalso();
  await od.gravarJson('estado/db.json', JSON.stringify(dbAntigo()));
  const c = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await c.travar();

  const lido = await c.lerBanco();
  assert.equal(lido.antigo, true);
  assert.equal(lido.dados.messages.geral[0].text, 'oi');

  const db = lido.dados;
  od.gravacoes.length = 0;
  await c.salvarBanco(db, 8);
  // os 3 canais e o db.json pequeno
  assert.equal(od.gravacoes.filter((p) => p.startsWith('estado/v2/mensagens/')).length, 3);
  assert.ok(od.gravacoes.includes('estado/v2/db.json'));
  assert.ok(!JSON.parse(od.arquivos.get('estado/v2/db.json').texto).messages, 'o db.json novo não leva mensagens');

  // uma mensagem nova em "memes": só esse canal sobe de novo
  db.messages.memes.push({ id: 'm4', text: 'mais um' });
  od.gravacoes.length = 0;
  await c.salvarBanco(db, 9);
  assert.equal(od.gravacoes.length, 2);
  assert.match(od.gravacoes[0], /^estado\/v2\/mensagens\/memes\.[0-9a-f]{16}\.json$/);
  assert.equal(od.gravacoes[1], 'estado/v2/db.json');
  // e o arquivo velho de "memes" saiu: só um por canal
  assert.equal([...od.arquivos.keys()].filter((p) => p.includes('/memes.')).length, 1);

  // canal apagado: o arquivo dele sai depois do db.json
  delete db.messages.geral;
  await c.salvarBanco(db, 10);
  assert.ok(![...od.arquivos.keys()].some((p) => p.includes('/geral.')));
  await c.liberar();

  // outro PC lê tudo de volta igual
  const outro = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await outro.travar();
  const relido = await outro.lerBanco();
  assert.equal(relido.antigo, false);
  assert.equal(relido.dados.versao, 10);
  assert.deepEqual(relido.dados.messages.memes.map((m) => m.text), ['kkk', 'mais um']);
  assert.equal(relido.dados.messages['dm:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb'][0].text, 'psiu');
  assert.equal(relido.dados.messages.geral, undefined);

  // nada mudou: só o db.json pequeno é gravado
  od.gravacoes.length = 0;
  await outro.salvarBanco(relido.dados, 11);
  assert.deepEqual(od.gravacoes, ['estado/v2/db.json']);
  await outro.liberar();
});

test('avisa quando um servidor sem atualizar mexeu no formato antigo', async () => {
  const od = oneDriveFalso();
  await od.gravarJson('estado/db.json', JSON.stringify(dbAntigo()));
  const c = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await c.travar();
  const lido = await c.lerBanco();
  await c.salvarBanco(lido.dados, 8);
  await c.liberar();

  // um servidor antigo grava no db.json velho
  const velho = dbAntigo(); velho.messages.geral.push({ id: 'm9', text: 'escrevi no antigo' });
  await od.gravarJson('estado/db.json', JSON.stringify(velho));

  const novo = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await novo.travar();
  let aviso = null;
  const lido2 = await novo.lerBanco({ aoAntigoMudar: (d) => { aviso = d; } });
  assert.equal(aviso.messages.geral[1].text, 'escrevi no antigo');
  assert.equal(lido2.avisou, true);
  // depois do envio seguinte, não avisa de novo
  await novo.salvarBanco(lido2.dados, 9);
  aviso = null;
  const lido3 = await novo.lerBanco({ aoAntigoMudar: (d) => { aviso = d; } });
  assert.equal(aviso, null);
  assert.equal(lido3.avisou, false);
  await novo.liberar();
});

test('o db.json não é gravado por cima de uma versão que outro servidor mudou', async () => {
  const od = oneDriveFalso();
  const c = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await c.travar();
  assert.equal(await c.lerBanco(), null);
  const db = { ...dbAntigo() };
  await c.salvarBanco(db, 1);
  // alguém mexeu no db.json por fora
  await od.gravarJson('estado/v2/db.json', '{"versao":99,"canais":{}}');
  await assert.rejects(c.salvarBanco(db, 2), (e) => e.codigo === 'conflito');
  await c.liberar();
});

test('um servidor que perdeu a vez não estraga as mensagens que o outro gravou', async () => {
  const od = oneDriveFalso();
  const a = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await a.travar();
  await a.lerBanco();
  const dbA = dbAntigo();
  await a.salvarBanco(dbA, 1);
  // B leu a mesma versão (a trava venceu e os dois acham que são donos)
  const b = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  const lidoB = await b.lerBanco();
  // A grava uma mensagem nova; depois B tenta gravar a cópia velha dele, com outra mudança
  dbA.messages.geral.push({ id: 'a1', text: 'de A' });
  await a.salvarBanco(dbA, 2);
  lidoB.dados.messages.geral.push({ id: 'b1', text: 'de B' });
  await assert.rejects(b.salvarBanco(lidoB.dados, 2), (e) => e.codigo === 'conflito');
  // quem lê depois vê exatamente o que A confirmou
  const c = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  const lido = await c.lerBanco();
  assert.deepEqual(lido.dados.messages.geral.map((m) => m.id), ['m1', 'a1']);
  await a.liberar();
});

test('canal sem o arquivo de mensagens: para em vez de apagar o histórico', async () => {
  const od = oneDriveFalso();
  const a = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await a.lerBanco();
  await a.salvarBanco(dbAntigo(), 1);
  for (const p of [...od.arquivos.keys()]) if (p.includes('/geral.')) od.arquivos.delete(p);
  const b = criarCompartilhado({ oneDrive: od, aoPerder() {} });
  await assert.rejects(b.lerBanco(), /faltam as mensagens do canal "geral"/);
});
