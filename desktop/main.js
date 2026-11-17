// DJAchat — app desktop (Electron)
'use strict';

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, Menu, Tray, nativeImage, clipboard, ClipboardItem } = require('electron');
const path = require('path');
const fs = require('fs');

// Pasta do cliente: copiada para ./client ao empacotar; em desenvolvimento usa ../client
const CLIENT = app.isPackaged ? path.join(__dirname, 'client') : path.join(__dirname, '..', 'client');

// mantém a voz funcionando com a janela minimizada
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let win;
let tray = null;   // ícone na bandeja do sistema (fica sempre lá enquanto o app está aberto)

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 560,
    backgroundColor: '#111824', title: 'DJAchat',
    frame: false,   // sem a moldura do Windows: o app desenha a própria barra (minimizar, maximizar, fechar)
    show: !NA_BANDEJA_AO_INICIAR,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(CLIENT, 'index.html'));

  // links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();   // o app nunca sai da própria página
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('maximize', () => win.webContents.send('janela-estado', { maximizada: true }));
  win.on('unmaximize', () => win.webContents.send('janela-estado', { maximizada: false }));
  win.on('enter-full-screen', () => win.webContents.send('janela-estado', { telaCheia: true }));
  win.on('leave-full-screen', () => win.webContents.send('janela-estado', { telaCheia: false }));

  // Clique direito em campos de texto e em texto selecionado: menu do sistema, com o corretor.
  // (Nas outras áreas o próprio app mostra o menu dele e este evento nem chega.)
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    const itens = [];
    if (p.misspelledWord) {
      for (const s of (p.dictionarySuggestions || []).slice(0, 5)) itens.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
      if (!itens.length) itens.push({ label: 'Sem sugestões', enabled: false });
      itens.push({ label: 'Adicionar ao dicionário', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    }
    if (p.isEditable) {
      itens.push({ role: 'cut', label: 'Recortar', enabled: p.editFlags.canCut }, { role: 'copy', label: 'Copiar', enabled: p.editFlags.canCopy },
        { role: 'paste', label: 'Colar', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: 'Selecionar tudo' });
    } else itens.push({ role: 'copy', label: 'Copiar' });
    Menu.buildFromTemplate(itens).popup({ window: win });
  });
  // recarregar a página com o seletor aberto não pode deixar o pedido de tela pendurado
  win.webContents.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) ipcMain.emit('picked', null, null, false); });
}

// ---------------------------------------------------------------- bandeja do sistema
// O X da barra esconde o app aqui (a voz continua). Para sair: clique direito no ícone → Sair do DJAchat.
const NA_BANDEJA_AO_INICIAR = process.argv.includes('--na-bandeja');   // usado ao iniciar com o Windows
let estadoApp = { conectado: false, voz: null, mutado: false, surdo: false };
const arquivoPrefs = () => path.join(app.getPath('userData'), 'janela.json');
function lerPrefs() { try { return JSON.parse(fs.readFileSync(arquivoPrefs(), 'utf8')); } catch { return {}; } }
function salvarPrefs(p) { try { fs.writeFileSync(arquivoPrefs(), JSON.stringify(p)); } catch { /* sem disco: só não lembra */ } }

function dicaBandeja(extra) { return 'DJAchat' + (estadoApp.voz ? ` — na ${estadoApp.voz}` : '') + (extra ? ` — ${extra}` : ''); }
function mostrarJanela() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (tray) tray.setToolTip(dicaBandeja());
}
function esconderNaBandeja() {
  if (!win) return;
  win.hide();
  const prefs = lerPrefs();
  if (!prefs.avisouBandeja && tray) {   // só na primeira vez
    tray.displayBalloon({ iconType: 'info', title: 'O DJAchat continua aberto', content: 'Ele fica aqui na bandeja e a voz não cai. Para sair, clique com o botão direito no ícone.' });
    salvarPrefs({ ...prefs, avisouBandeja: true });
  }
}
const comando = (c) => { if (win) win.webContents.send('comando', c); };
const sairDeVerdade = () => app.quit();

function montarMenuBandeja() {
  if (!tray) return;
  const itens = [{ label: 'Abrir o DJAchat', click: mostrarJanela }, { type: 'separator' }];
  if (estadoApp.conectado) {
    itens.push(
      { label: 'Microfone mutado', type: 'checkbox', checked: estadoApp.mutado, click: () => comando('mutar') },
      { label: 'Ensurdecido', type: 'checkbox', checked: estadoApp.surdo, click: () => comando('ensurdecer') });
    if (estadoApp.voz) itens.push({ label: `Sair da sala de voz (${estadoApp.voz})`, click: () => comando('sair-voz') });
    itens.push({ type: 'separator' });
  }
  itens.push({ label: 'Configurações', click: () => { mostrarJanela(); comando('configuracoes'); } });
  if (app.isPackaged) {   // no modo de desenvolvimento registraria o Electron, não o DJAchat
    const login = app.getLoginItemSettings({ args: ['--na-bandeja'] });
    itens.push({ label: 'Iniciar com o Windows', type: 'checkbox', checked: login.openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--na-bandeja'] }) });
  }
  itens.push({ type: 'separator' }, { label: 'Sair do DJAchat', click: sairDeVerdade });
  tray.setContextMenu(Menu.buildFromTemplate(itens));
  tray.setToolTip(dicaBandeja());
}
function criarBandeja() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 32, height: 32 }));
  tray.on('click', mostrarJanela);
  montarMenuBandeja();
}

// Abrir o DJAchat de novo traz a janela que está na bandeja, em vez de abrir outra cópia
const unica = app.requestSingleInstanceLock();
app.on('second-instance', mostrarJanela);

app.whenReady().then(() => {
  if (!unica) { app.quit(); return; }   // já está aberto: o outro mostra a janela
  // sem a barra de menus padrão (File, Edit, View...): o que interessa fica em Configurações
  Menu.setApplicationMenu(null);
  // microfone, tela e notificações liberados
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  // getDisplayMedia → mostra nosso seletor de tela/janela dentro do app.
  // Só um pedido fica aberto: um pedido novo (ou a página recarregada) encerra o anterior,
  // senão a resposta do seletor ia para o pedido velho e o novo ficava pendurado.
  let responderTela = null;
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    if (responderTela) responderTela(null);
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    } catch (e) { console.error(e); return callback(null); }   // null recusa o pedido; {} lança exceção
    let respondido = false;
    const responder = (id, withAudio) => {
      if (respondido) return;
      respondido = true;
      if (responderTela === responder) responderTela = null;
      const src = id && sources.find((s) => s.id === id);
      if (!src) return callback(null);   // cancelou no seletor
      const result = { video: src };
      if (withAudio && process.platform === 'win32') result.audio = 'loopback';   // som do PC (só Windows)
      callback(result);
    };
    responderTela = responder;
    win.webContents.send('pick-source', sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })));
  });
  ipcMain.on('picked', (_e, id, withAudio) => { if (responderTela) responderTela(id, withAudio); });

  ipcMain.on('flash', () => {
    if (!win) return;
    if (!win.isVisible()) { if (tray) tray.setToolTip(dicaBandeja('mensagem nova')); }   // na bandeja: avisa no ícone
    else if (!win.isFocused()) win.flashFrame(true);
  });
  // comandos da barra própria e das Configurações
  ipcMain.on('janela', (e, acao, valor) => {
    if (!win || e.sender !== win.webContents) return;
    switch (acao) {
      case 'minimizar': win.minimize(); break;
      case 'maximizar': if (win.isMaximized()) win.unmaximize(); else win.maximize(); break;
      case 'fechar': esconderNaBandeja(); break;   // o X só esconde; Alt+F4 e a barra de tarefas fecham de verdade
      case 'zoom': win.webContents.setZoomFactor(Math.min(2, Math.max(0.5, Number(valor) || 1))); break;
      case 'tela-cheia': win.setFullScreen(!win.isFullScreen()); break;
      case 'recarregar': win.webContents.reload(); break;
      case 'devtools': win.webContents.toggleDevTools(); break;
      case 'sair': sairDeVerdade(); break;
    }
  });
  // "Baixar…" no menu de um anexo: abre a janela de salvar do Windows
  ipcMain.on('baixar', (_e, url) => { if (win && /^https?:\/\//i.test(url)) win.webContents.downloadURL(url); });
  try { session.defaultSession.setSpellCheckerLanguages(['pt-BR']); } catch { /* idioma indisponível: fica o padrão */ }
  ipcMain.handle('copiar-texto', async (_e, texto) => { await clipboard.writeText(String(texto).slice(0, 100000)); return true; });
  ipcMain.handle('copiar-imagem', async (_e, png) => {
    const bytes = Buffer.from(png);
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('não é um PNG');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    return true;
  });

  // o que o app conta para o menu da bandeja: conectado, sala, mudo, surdo
  ipcMain.on('estado-app', (_e, estado) => {
    estadoApp = { conectado: !!estado.conectado, voz: estado.voz ? String(estado.voz).slice(0, 40) : null, mutado: !!estado.mutado, surdo: !!estado.surdo };
    montarMenuBandeja();
  });

  criarBandeja();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
