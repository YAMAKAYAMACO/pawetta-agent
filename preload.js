'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pawettaAgent', {
  account: () => ipcRenderer.invoke('agent:account'),
  login: () => ipcRenderer.invoke('agent:login'),
  logout: () => ipcRenderer.invoke('agent:logout'),
  activity: limit => ipcRenderer.invoke('agent:activity', limit),
  clearActivity: () => ipcRenderer.invoke('agent:clear-activity'),
  logActivity: payload => ipcRenderer.invoke('agent:log', payload),
  preferences: () => ipcRenderer.invoke('agent:preferences'),
  setPreferences: next => ipcRenderer.invoke('agent:set-preferences', next),
  checkUpdate: () => ipcRenderer.invoke('agent:check-update'),
  selectProject: () => ipcRenderer.invoke('agent:select-project'),
  status: () => ipcRenderer.invoke('agent:status'),
  tree: options => ipcRenderer.invoke('agent:tree', options),
  index: force => ipcRenderer.invoke('agent:index', force),
  listDirectory: request => ipcRenderer.invoke('agent:list-directory', request),
  readFile: filePath => ipcRenderer.invoke('agent:read-file', filePath),
  readMany: paths => ipcRenderer.invoke('agent:read-many', paths),
  search: query => ipcRenderer.invoke('agent:search', query),
  systemInfo: () => ipcRenderer.invoke('agent:system-info'),
  httpRequest: request => ipcRenderer.invoke('agent:http-request', request),
  openUrl: url => ipcRenderer.invoke('agent:open-url', url),
  openPath: filePath => ipcRenderer.invoke('agent:open-path', filePath),
  writeClipboard: text => ipcRenderer.invoke('agent:clipboard-write', text),
  launchApp: appId => ipcRenderer.invoke('agent:launch-app', appId),
  previewWrite: request => ipcRenderer.invoke('agent:preview-write', request),
  writeFile: request => ipcRenderer.invoke('agent:write-file', request),
  previewEdit: request => ipcRenderer.invoke('agent:preview-edit', request),
  editFile: request => ipcRenderer.invoke('agent:edit-file', request),
  createCheckpoint: () => ipcRenderer.invoke('agent:create-checkpoint'),
  rollbackCheckpoint: id => ipcRenderer.invoke('agent:rollback-checkpoint', id),
  discardCheckpoint: id => ipcRenderer.invoke('agent:discard-checkpoint', id),
  undoWrite: token => ipcRenderer.invoke('agent:undo-write', token),
  runCommand: request => ipcRenderer.invoke('agent:run-command', request),
  startChat: request => ipcRenderer.send('agent:chat-start', request),
  abortChat: requestId => ipcRenderer.send('agent:chat-abort', requestId),
  onChatEvent: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:chat-event', listener);
    return () => ipcRenderer.removeListener('agent:chat-event', listener);
  },
  onNewTask: callback => {
    const listener = () => callback();
    ipcRenderer.on('agent:new-task', listener);
    return () => ipcRenderer.removeListener('agent:new-task', listener);
  },
  onPreferencesChanged: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:preferences-changed', listener);
    return () => ipcRenderer.removeListener('agent:preferences-changed', listener);
  },
  openPawetta: url => ipcRenderer.invoke('agent:open-external', url)
});
