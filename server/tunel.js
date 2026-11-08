// DJAchat — endereço público pelo Cloudflare Tunnel, sem abrir portas no roteador
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function localizar() {
  const pastas = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  const achado = pastas.map((p) => path.join(p, 'cloudflared', 'cloudflared.exe')).find((p) => fs.existsSync(p));
  return process.env.CLOUDFLARED || achado || 'cloudflared';
}

function iniciarTunel(porta, aoObterEndereco, avisar) {
  let filho = null, encerrando = false;

  function abrir() {
    filho = spawn(localizar(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${porta}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let achou = false;
    const ler = (d) => {
      const m = !achou && String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { achou = true; aoObterEndereco(m[0]); }
    };
    filho.stdout.on('data', ler);
    filho.stderr.on('data', ler);
    filho.on('error', (e) => { encerrando = true; avisar(`Não consegui iniciar o cloudflared: ${e.message}`); });
    filho.on('exit', () => {
      if (encerrando) return;
      avisar('O túnel caiu. Reabrindo em 5 segundos (o endereço pode mudar)...');
      setTimeout(abrir, 5000);
    });
  }
  abrir();

  const encerrar = () => { encerrando = true; if (filho) filho.kill(); };
  process.on('exit', encerrar);
  for (const sinal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sinal, () => process.exit(0));
}

module.exports = { iniciarTunel };
