// DJAchat — dados do grupo no OneDrive, os mesmos em qualquer PC que abrir o servidor.
// Só um servidor fica ativo por vez: ele segura uma trava (estado/trava.json) e a renova a cada 30 s.
// Se a trava ficar sem renovar (o PC desligou sem fechar o servidor), outro PC assume depois do prazo.
'use strict';

const crypto = require('crypto');
const os = require('os');

const TRAVA = 'estado/trava.json';
const BANCO = 'estado/db.json';
const CONFIG = 'estado/config.json';

function criarCompartilhado({ oneDrive, prazoMs = 120000, batidaMs = Math.min(30000, prazoMs / 4), aoPerder }) {
  const meu = { id: crypto.randomBytes(8).toString('hex'), maquina: os.hostname() };
  let etagTrava = null, etagBanco = null, renovadaEm = 0, batida = null, perdida = false;

  function perder(motivo) {
    if (perdida) return;
    perdida = true;
    clearInterval(batida);
    aoPerder(motivo);
  }

  async function travar() {
    const corpo = JSON.stringify({ ...meu, desde: new Date().toISOString() });
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      try {
        etagTrava = (await oneDrive.gravarJson(TRAVA, corpo, { criar: true })).etag;
        break;
      } catch (e) { if (e.codigo !== 'conflito') throw e; }
      const atual = await oneDrive.lerJson(TRAVA);
      if (!atual) continue;   // foi liberada agora mesmo: tenta criar de novo
      const parada = atual.agora - atual.modificado;
      if (parada < prazoMs) {
        const quem = atual.dados.maquina || 'outro PC';
        const espera = Math.ceil((prazoMs - parada) / 1000);
        const e = new Error(`o servidor já está aberto em "${quem}". Feche aquele primeiro. Se aquele PC desligou sem fechar o servidor, espere ${espera} s e tente de novo.`);
        e.codigo = 'ocupado';
        throw e;
      }
      try {
        etagTrava = (await oneDrive.gravarJson(TRAVA, corpo, { etag: atual.etag })).etag;   // assume a trava abandonada
        break;
      } catch (e) { if (e.codigo !== 'conflito') throw e; }
    }
    if (!etagTrava) throw Object.assign(new Error('outro servidor pegou a trava ao mesmo tempo'), { codigo: 'ocupado' });
    renovadaEm = Date.now();
    batida = setInterval(renovar, batidaMs);
  }

  async function renovar() {
    if (perdida) return;
    try {
      etagTrava = (await oneDrive.gravarJson(TRAVA, JSON.stringify({ ...meu, renovada: new Date().toISOString() }), { etag: etagTrava })).etag;
      renovadaEm = Date.now();
    } catch (e) {
      if (e.codigo === 'conflito') return perder('outro servidor assumiu os dados do grupo');
      // sem contato por tempo demais, outro PC pode assumir: parar antes que os dois gravem
      if (Date.now() - renovadaEm > prazoMs - batidaMs) perder(`sem contato com o OneDrive (${e.message})`);
    }
  }

  async function liberar() {
    clearInterval(batida);
    if (perdida || !etagTrava) return;
    perdida = true;
    await oneDrive.apagarSeIgual(TRAVA, etagTrava);
  }

  // Grava o banco só se for a versão que este servidor leu ou gravou por último
  async function salvarBanco(texto) {
    if (perdida) throw Object.assign(new Error('a trava foi perdida'), { codigo: 'conflito' });
    const r = await oneDrive.gravarJson(BANCO, texto, etagBanco ? { etag: etagBanco } : { criar: true });
    etagBanco = r.etag;
  }
  async function lerBanco() {
    const r = await oneDrive.lerJson(BANCO);
    etagBanco = r ? r.etag : null;
    return r && r.dados;
  }

  async function lerConfig() {
    const r = await oneDrive.lerJson(CONFIG);
    return r && r.dados;
  }
  async function criarConfig(dados) {
    await oneDrive.gravarJson(CONFIG, JSON.stringify(dados), { criar: true });
  }

  return { travar, liberar, salvarBanco, lerBanco, lerConfig, criarConfig, maquina: meu.maquina, get ativa() { return !!etagTrava && !perdida; } };
}

module.exports = { criarCompartilhado };
