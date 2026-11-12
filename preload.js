'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Only these actions are available to the window – no Node.js access.
contextBridge.exposeInMainWorld('worklog', {
  state: () => ipcRenderer.invoke('state'),
  login: (server, email, password, code) => ipcRenderer.invoke('login', { server, email, password, code }),
  logout: () => ipcRenderer.invoke('logout'),
  acceptPolicy: () => ipcRenderer.invoke('acceptPolicy'),
  start: () => ipcRenderer.invoke('start'),
  takeBreak: () => ipcRenderer.invoke('break'),
  stop: () => ipcRenderer.invoke('stop'),
  resolveIdle: (choice) => ipcRenderer.invoke('resolveIdle', choice),
  openDashboard: () => ipcRenderer.invoke('openDashboard'),
  openScreenSettings: () => ipcRenderer.invoke('openScreenSettings'),
  setAutoLaunch: (on) => ipcRenderer.invoke('setAutoLaunch', on),
  sync: () => ipcRenderer.invoke('sync'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
