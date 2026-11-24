// DJAchat — testes das menções do app (client/texto.js)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mencionaNome } = require('../../client/texto');

test('menção pelo apelido, sem diferença de maiúsculas', () => {
  assert.equal(mencionaNome('ei @absoll, bora?', 'Absoll'), true);
  assert.equal(mencionaNome('@Absoll', 'Absoll'), true);
  assert.equal(mencionaNome('fala @Ana Maria', 'Ana Maria'), true);
});

test('@todos chama todo mundo', () => {
  assert.equal(mencionaNome('reunião @todos', 'Qualquer'), true);
  assert.equal(mencionaNome('@everyone', 'Qualquer'), true);
});

test('não confunde com outro apelido nem com e-mail', () => {
  assert.equal(mencionaNome('oi @Absoll2', 'Absoll'), false);
  assert.equal(mencionaNome('absoll sem arroba', 'Absoll'), false);
  assert.equal(mencionaNome('', 'Absoll'), false);
  assert.equal(mencionaNome('@todosjuntos', 'Absoll'), false);
});
