'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('djachatDesktop', {
  onPickSource: (cb) => ipcRenderer.on('pick-source', (_e, sources) => cb(sources)),
  pickSource: (id, withAudio) => ipcRenderer.send('picked', id, withAudio),
  flash: () => ipcRenderer.send('flash'),
});
