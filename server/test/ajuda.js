// DJAchat — utilidades dos testes: sobe um servidor numa pasta temporária e conecta "amigos falsos"
'use strict';

const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SERVIDOR = path.join(__dirname, '..', 'server.js');
const SENHA = 'senha-de-teste';

// Abre um servidor novo, com dados vazios. Devolve { base, porta, pasta, fechar() }.
async function abrirServidor(env = {}) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'djachat-teste-'));
  const porta = 41000 + Math.floor(Math.random() * 20000);
  const filho = fork(SERVIDOR, [], {
    env: { ...process.env, PORT: String(porta), DATA_DIR: pasta, SENHA, HOST: '127.0.0.1', ONEDRIVE_CLIENT_ID: 'teste', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let saida = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('o servidor não abriu: ' + saida)), 10000);
    const ler = (d) => { saida += d; if (saida.includes('rodando na porta')) { clearTimeout(t); resolve(); } };
    filho.stdout.on('data', ler);
    filho.stderr.on('data', (d) => { saida += d; });
    filho.on('exit', (c) => { clearTimeout(t); reject(new Error(`o servidor fechou (${c}): ${saida}`)); });
  });
  filho.removeAllListeners('exit');
  return {
    base: `http://127.0.0.1:${porta}`, porta, pasta,
    get saida() { return saida; },
    async fechar() {
      await new Promise((r) => { filho.once('exit', r); filho.send('encerrar'); setTimeout(() => filho.kill(), 5000); });
      fs.rmSync(pasta, { recursive: true, force: true });
    },
  };
}

// Um "amigo" conectado: guarda tudo o que recebe e espera por mensagens de um tipo
async function conectar(srv, nome, { senha = SENHA, chave = crypto.randomBytes(32).toString('hex') } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.porta}/ws`);
  const recebidas = [];
  const esperando = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    recebidas.push(m);
    for (const w of [...esperando]) if (w.filtro(m)) { esperando.splice(esperando.indexOf(w), 1); w.resolve(m); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('não conectou')); });
  const c = {
    ws, nome, chave, recebidas,
    mandar: (obj) => ws.send(JSON.stringify(obj)),
    // espera a próxima mensagem (ainda não lida) que passe no filtro
    esperar(tipo, filtro = () => true, ms = 3000) {
      const passa = (m) => m.t === tipo && filtro(m);
      const ja = recebidas.find((m) => !m._lida && passa(m));
      if (ja) { ja._lida = true; return Promise.resolve(ja); }
      return new Promise((resolve, reject) => {
        const w = { filtro: passa, resolve: (m) => { clearTimeout(t); m._lida = true; resolve(m); } };
        const t = setTimeout(() => { esperando.splice(esperando.indexOf(w), 1); reject(new Error(`${nome} não recebeu "${tipo}"`)); }, ms);
        esperando.push(w);
      });
    },
    // confere que nada desse tipo chega no tempo dado
    async naoRecebe(tipo, filtro = () => true, ms = 400) {
      await new Promise((r) => setTimeout(r, ms));
      return !recebidas.some((m) => !m._lida && m.t === tipo && filtro(m));
    },
    fechar: () => ws.close(),
  };
  c.mandar({ t: 'hello', name: nome, password: senha, chave });
  return c;
}

// conecta e espera o "welcome"
async function entrar(srv, nome, opcoes) {
  const c = await conectar(srv, nome, opcoes);
  c.welcome = await c.esperar('welcome');
  c.me = c.welcome.you;
  return c;
}

module.exports = { abrirServidor, conectar, entrar, SENHA };
