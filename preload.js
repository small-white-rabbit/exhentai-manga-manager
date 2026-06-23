const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('ipcRenderer', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
})

contextBridge.exposeInMainWorld('electronFunction', {
  'get-zoom-level': () => webFrame.getZoomLevel(),
  'set-zoom-level': (level) => webFrame.setZoomLevel(level),
  'insert-css': (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
})