// DJAchat — acesso ao OneDrive pela API Microsoft Graph (somente a pasta do app)
'use strict';

const fs = require('fs');
const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const PARTE = 32 * 327680;   // 10 MiB: o OneDrive exige partes em múltiplos de 320 KiB
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), signal: AbortSignal.timeout(30000) });

// O OneDrive recusa alguns caracteres; o nome original continua guardado no banco
const nomeRemoto = (nome) => nome.replace(/["*:<>?/\\|#%]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'arquivo';

// erro com código: 'conflito' quando outra cópia mudou o arquivo antes (HTTP 409/412)
function erroHttp(acao, status) {
  const e = new Error(`${acao}: HTTP ${status}`);
  e.status = status;
  if (status === 409 || status === 412) e.codigo = 'conflito';
  return e;
}

function criarOneDrive({ clientId, obterRefresh, salvarRefresh, prefixo = '' }) {
  let access = null, expira = 0, renovando = null;
  const links = new Map();   // itemId -> { url, ate }
  // prefixo: subpasta dentro da pasta do app (usado só para testes isolados)
  const caminho = (p) => `/me/drive/special/approot:/${(prefixo ? `${prefixo}/${p}` : p).split('/').map(encodeURIComponent).join('/')}:`;

  async function renovar() {
    const r = await fetch(`${AUTH}/token`, form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: obterRefresh(), scope: SCOPE }));
    const j = await r.json();
    if (!r.ok) throw new Error(`autorização do OneDrive recusada: ${j.error}${j.error === 'invalid_grant' ? ' (conecte de novo com --conectar-onedrive)' : ''}`);
    if (j.refresh_token) salvarRefresh(j.refresh_token);
    access = j.access_token;
    expira = Date.now() + j.expires_in * 1000;
    return access;
  }
  function token() {
    if (access && Date.now() < expira - 60000) return access;
    renovando ||= renovar().finally(() => { renovando = null; });
    return renovando;
  }

  async function graph(p, opcoes = {}, tentativa = 0) {
    const r = await fetch(GRAPH + p, { ...opcoes, headers: { authorization: `Bearer ${await token()}`, ...opcoes.headers }, signal: AbortSignal.timeout(60000) });
    if (r.status === 401 && tentativa === 0) { access = null; return graph(p, opcoes, 1); }
    if ((r.status === 429 || r.status === 503) && tentativa < 2) {
      await sleep(Math.min(Number(r.headers.get('retry-after')) || 2, 30) * 1000);
      return graph(p, opcoes, tentativa + 1);
    }
    return r;
  }
  async function jsonOuErro(r, acao) {
    if (!r.ok) throw erroHttp(acao, r.status);
    return r.json();
  }
  const horaDe = (r) => Date.parse(r.headers.get('date')) || Date.now();

  // envia um arquivo do disco por sessão de upload, em partes; devolve o item criado
  async function enviarDoDisco(destino, arquivo, tamanho) {
    const r = await graph(`${caminho(destino)}/createUploadSession`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
    });
    const { uploadUrl } = await jsonOuErro(r, 'criar envio');
    const fd = await fs.promises.open(arquivo, 'r');
    try {
      for (let inicio = 0; inicio < tamanho; inicio += PARTE) {
        const fim = Math.min(inicio + PARTE, tamanho);
        const pedaco = Buffer.alloc(fim - inicio);
        await fd.read(pedaco, 0, pedaco.length, inicio);
        for (let tentativa = 1; ; tentativa++) {
          const p = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-range': `bytes ${inicio}-${fim - 1}/${tamanho}` }, body: pedaco, signal: AbortSignal.timeout(300000) }).catch((e) => e);
          if (p instanceof Response && p.ok) { if (fim === tamanho) return p.json(); break; }
          if (tentativa === 3) throw p instanceof Response ? erroHttp('enviar parte', p.status) : p;
          await sleep(2000 * tentativa);
        }
      }
    } finally { await fd.close(); }
    throw new Error('envio sem conteúdo');
  }

  const caminhoArquivo = (id, nome) => `arquivos/${id}/${nomeRemoto(nome)}`;

  return {
    get ativo() { return !!obterRefresh(); },

    async criarEnvio(id, nome) {
      const r = await graph(`${caminho(caminhoArquivo(id, nome))}/createUploadSession`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
      });
      return (await jsonOuErro(r, 'criar envio')).uploadUrl;
    },
    async detalhes(id, nome) {
      return jsonOuErro(await graph(`${caminho(caminhoArquivo(id, nome))}?select=id,size,parentReference`), 'consultar arquivo');
    },
    async link(itemId) {
      const salvo = links.get(itemId);
      if (salvo && salvo.ate > Date.now()) return salvo.url;
      const j = await jsonOuErro(await graph(`/me/drive/items/${itemId}?select=id,@microsoft.graph.downloadUrl`), 'gerar link');
      const url = j['@microsoft.graph.downloadUrl'];
      links.set(itemId, { url, ate: Date.now() + 15 * 60000 });
      return url;
    },
    async apagar(itemId) {
      const r = await graph(`/me/drive/items/${itemId}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`apagar: HTTP ${r.status}`);
    },
    async apagarCaminho(p) {
      const r = await graph(caminho(p), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`apagar: HTTP ${r.status}`);
    },
    async gravar(p, corpo) {
      const r = await graph(`${caminho(p)}/content`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: corpo });
      return jsonOuErro(r, 'gravar');
    },

    // Leitura com versão: { dados, etag, modificado, agora } ou null se não existir.
    // "agora" vem do relógio da Microsoft, para comparar com "modificado" sem depender do relógio do PC.
    async lerJson(p) {
      const r = await graph(`${caminho(p)}?select=eTag,lastModifiedDateTime,@microsoft.graph.downloadUrl`);
      if (r.status === 404) return null;
      const meta = await jsonOuErro(r, `ler ${p}`);
      const c = await fetch(meta['@microsoft.graph.downloadUrl'], { signal: AbortSignal.timeout(120000) });
      if (!c.ok) throw erroHttp(`baixar ${p}`, c.status);
      return { dados: JSON.parse(await c.text()), etag: meta.eTag, modificado: Date.parse(meta.lastModifiedDateTime), agora: horaDe(r) };
    },
    // Grava só se ninguém mudou antes: com etag, exige essa versão; com criar, exige que não exista.
    async gravarJson(p, corpo, { etag, criar } = {}) {
      const headers = { 'content-type': 'application/json' };
      if (etag) headers['if-match'] = etag;
      const r = await graph(`${caminho(p)}/content${criar ? '?@microsoft.graph.conflictBehavior=fail' : ''}`, { method: 'PUT', headers, body: corpo });
      const item = await jsonOuErro(r, `gravar ${p}`);
      return { etag: item.eTag, modificado: Date.parse(item.lastModifiedDateTime), agora: horaDe(r) };
    },
    async apagarSeIgual(p, etag) {
      const r = await graph(caminho(p), { method: 'DELETE', headers: { 'if-match': etag } });
      if (!r.ok && r.status !== 404) throw erroHttp(`apagar ${p}`, r.status);
    },
    // Leva um arquivo do disco para arquivos/<id>/<nome>; devolve { remote, pasta }
    async enviarArquivo(id, nome, arquivo, tamanho) {
      const destino = caminhoArquivo(id, nome);
      const item = tamanho <= 4 * 1024 * 1024
        ? await jsonOuErro(await graph(`${caminho(destino)}/content?@microsoft.graph.conflictBehavior=replace`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: await fs.promises.readFile(arquivo) }), 'enviar arquivo')
        : await enviarDoDisco(destino, arquivo, tamanho);
      if (item.size !== tamanho) throw new Error(`o arquivo chegou com ${item.size} de ${tamanho} bytes`);
      return { remote: item.id, pasta: item.parentReference.id };
    },
    async listar(p) {
      const r = await graph(`${caminho(p)}/children?select=id,name&$top=200`);
      if (r.status === 404) return [];
      return (await jsonOuErro(r, 'listar')).value;
    },

    // Autorização única: mostra um código para digitar no site da Microsoft
    async conectar(avisar) {
      const r = await fetch(`${AUTH}/devicecode`, form({ client_id: clientId, scope: SCOPE }));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error_description || d.error);
      avisar(`\n  Abra ${d.verification_uri} e digite o código: ${d.user_code}\n`);
      const fim = Date.now() + d.expires_in * 1000;
      while (Date.now() < fim) {
        await sleep((d.interval || 5) * 1000);
        const t = await fetch(`${AUTH}/token`, form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: d.device_code }));
        const j = await t.json();
        if (t.ok) { salvarRefresh(j.refresh_token); return; }
        if (j.error !== 'authorization_pending' && j.error !== 'slow_down') {
          const motivo = { authorization_declined: 'a permissão foi recusada na tela da Microsoft', expired_token: 'o código expirou', bad_verification_code: 'o código digitado não confere' }[j.error];
          throw new Error(motivo || `${j.error}${j.error_description ? ` — ${j.error_description.split('\r\n')[0]}` : ''}`);
        }
      }
      throw new Error('o código expirou');
    },
  };
}

module.exports = { criarOneDrive };
