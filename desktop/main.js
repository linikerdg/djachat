// DJAchat — app desktop (Electron)
'use strict';

const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require('electron');
const path = require('path');

// Pasta do cliente: copiada para ./client ao empacotar; em desenvolvimento usa ../client
const CLIENT = app.isPackaged ? path.join(__dirname, 'client') : path.join(__dirname, '..', 'client');

// mantém a voz funcionando com a janela minimizada
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 560,
    backgroundColor: '#1e2838', title: 'DJAchat', autoHideMenuBar: true,
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
}

app.whenReady().then(() => {
  // microfone, tela e notificações liberados
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  // getDisplayMedia → mostra nosso seletor de tela/janela dentro do app
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    } catch (e) { console.error(e); return callback({}); }
    win.webContents.send('pick-source', sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })));
    ipcMain.once('picked', (_e, id, withAudio) => {
      const src = sources.find((s) => s.id === id);
      if (!src) return callback({});
      const result = { video: src };
      if (withAudio && process.platform === 'win32') result.audio = 'loopback';   // som do PC (só Windows)
      callback(result);
    });
  });

  ipcMain.on('flash', () => { if (win && !win.isFocused()) win.flashFrame(true); });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
