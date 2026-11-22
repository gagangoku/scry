const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  search: (query, project) => ipcRenderer.invoke('search', query, project),
  projects: () => ipcRenderer.invoke('projects'),
  createProject: (name) => ipcRenderer.invoke('createProject', name),
  rotateToken: (name) => ipcRenderer.invoke('rotateToken', name),
  sessions: (project) => ipcRenderer.invoke('sessions', project),
  session: (project, id) => ipcRenderer.invoke('session', project, id),
  config: () => ipcRenderer.invoke('config'),
});
