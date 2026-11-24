// DJAchat — dados do grupo no OneDrive, os mesmos em qualquer PC que abrir o servidor.
// Só um servidor fica ativo por vez: ele segura uma trava (estado/trava.json) e a renova a cada 30 s.
// Se a trava ficar sem renovar (o PC desligou sem fechar o servidor), outro PC assume depois do prazo.
'use strict';

const crypto = require('crypto');
const os = require('os');

const TRAVA = 'estado/trava.json';
const BANCO = 'estado/db.json';          // formato antigo: tudo num arquivo só
const BANCO2 = 'estado/v2/db.json';      // formato 2: canais, arquivos, sons e contas
const MENSAGENS = 'estado/v2/mensagens'; // formato 2: um arquivo de mensagens por canal
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

  // ------------------------------------------------------------ banco (formato 2)
  // As mensagens ficam num arquivo por canal (estado/v2/mensagens/<canal>.json) e o resto num arquivo
  // pequeno (estado/v2/db.json). Cada envio leva só os canais que mudaram, e por último o db.json,
  // que só é gravado se for a versão que este servidor leu ou gravou (é ele que "confirma" o envio).
  // O formato antigo (estado/db.json, tudo num arquivo só) é lido uma vez e convertido; ele fica
  // lá parado, como cópia.
  const enviados = new Map();   // canal -> hash do conteúdo que está no OneDrive
  const hash = (texto) => crypto.createHash('sha1').update(texto).digest('hex');
  const arquivoCanal = (canal) => `${MENSAGENS}/${String(canal).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;

  // Grava o banco: canais mudados, canais apagados e, por fim, o db.json
  async function salvarBanco(db, versao) {
    if (perdida) throw Object.assign(new Error('a trava foi perdida'), { codigo: 'conflito' });
    const { messages, ...resto } = db;
    const novos = new Map();
    for (const [canal, lista] of Object.entries(messages)) {
      const texto = JSON.stringify(lista);
      const h = hash(texto);
      novos.set(canal, h);
      if (enviados.get(canal) === h) continue;
      await oneDrive.gravarJson(arquivoCanal(canal), texto);
      enviados.set(canal, h);
      if (perdida) throw Object.assign(new Error('a trava foi perdida'), { codigo: 'conflito' });
    }
    const meta = JSON.stringify({ ...resto, versao, canais: [...novos.keys()], ...(migradoDe ? { migradoDe } : {}) });
    const r = await oneDrive.gravarJson(BANCO2, meta, etagBanco ? { etag: etagBanco } : { criar: true });
    etagBanco = r.etag;
    // só depois do db.json novo: os canais que ele não lista mais podem sair
    for (const canal of [...enviados.keys()]) {
      if (novos.has(canal)) continue;
      enviados.delete(canal);
      await oneDrive.apagarCaminho(arquivoCanal(canal)).catch(() => {});
    }
  }

  let migradoDe = null;   // etag do db.json antigo no momento da conversão
  // Lê o banco inteiro: { dados, antigo } ou null quando a conta ainda não tem dados.
  // antigo = veio do formato antigo e precisa ser enviado inteiro no formato novo.
  // aoAntigoMudar(dados): o db.json antigo mudou depois da conversão (um servidor sem atualizar abriu).
  async function lerBanco({ aoAntigoMudar } = {}) {
    const r = await oneDrive.lerJson(BANCO2);
    if (!r) {
      enviados.clear();
      const velho = await oneDrive.lerJson(BANCO);
      etagBanco = null;
      if (!velho) return null;
      migradoDe = velho.etag;
      return { dados: velho.dados, antigo: true };
    }
    etagBanco = r.etag;
    const { canais = [], migradoDe: m, ...dados } = r.dados;
    migradoDe = m || null;
    dados.messages = {};
    enviados.clear();
    for (const canal of canais) {
      const c = await oneDrive.lerJson(arquivoCanal(canal));
      if (!c) continue;   // canal sem arquivo: o envio parou no meio; os outros dados valem
      dados.messages[canal] = c.dados;
      enviados.set(canal, hash(JSON.stringify(c.dados)));
    }
    let avisou = false;
    if (migradoDe && aoAntigoMudar) {
      const velho = await oneDrive.lerJson(BANCO).catch(() => null);
      if (velho && velho.etag !== migradoDe) {
        aoAntigoMudar(velho.dados);
        migradoDe = velho.etag;   // avisa uma vez só: o próximo envio grava a marca nova
        avisou = true;
      }
    }
    return { dados, antigo: false, avisou };
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
