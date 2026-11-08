// DJAchat — acesso ao OneDrive pela API Microsoft Graph (somente a pasta do app)
'use strict';

const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), signal: AbortSignal.timeout(30000) });
const caminho = (p) => `/me/drive/special/approot:/${p.split('/').map(encodeURIComponent).join('/')}:`;

// O OneDrive recusa alguns caracteres; o nome original continua guardado no banco
const nomeRemoto = (nome) => nome.replace(/["*:<>?/\\|#%]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'arquivo';

function criarOneDrive({ clientId, obterRefresh, salvarRefresh }) {
  let access = null, expira = 0, renovando = null;
  const links = new Map();   // itemId -> { url, ate }

  async function renovar() {
    const r = await fetch(`${AUTH}/token`, form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: obterRefresh(), scope: SCOPE }));
    const j = await r.json();
    if (!r.ok) throw new Error(`autorização do OneDrive recusada: ${j.error}`);
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
    if (!r.ok) throw new Error(`${acao}: HTTP ${r.status}`);
    return r.json();
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
      await jsonOuErro(r, 'gravar');
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
        if (j.error !== 'authorization_pending' && j.error !== 'slow_down') throw new Error(j.error);
      }
      throw new Error('o código expirou');
    },
  };
}

module.exports = { criarOneDrive };
