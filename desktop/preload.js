'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('djachatDesktop', {
  onPickSource: (cb) => ipcRenderer.on('pick-source', (_e, sources) => cb(sources)),
  pickSource: (id, withAudio) => ipcRenderer.send('picked', id, withAudio),
  flash: () => ipcRenderer.send('flash'),
  // barra própria da janela e opções que saíram do menu padrão
  janela: (acao, valor) => ipcRenderer.send('janela', String(acao), valor),
  aoMudarJanela: (cb) => ipcRenderer.on('janela-estado', (_e, estado) => cb(estado)),
  // menu da bandeja: o app informa o estado e recebe os comandos escolhidos lá
  informarEstado: (estado) => ipcRenderer.send('estado-app', estado),
  aoComando: (cb) => ipcRenderer.on('comando', (_e, c) => cb(String(c))),
  baixar: (url) => ipcRenderer.send('baixar', String(url)),
  // área de transferência do sistema (não depende de a janela estar em foco)
  copiarTexto: (texto) => ipcRenderer.invoke('copiar-texto', String(texto)),
  copiarImagem: (png) => ipcRenderer.invoke('copiar-imagem', png),
});
