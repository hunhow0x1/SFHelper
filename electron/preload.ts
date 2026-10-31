import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sfhelperConsent", {
  accept: () => ipcRenderer.send("consent:accept"),
  decline: () => ipcRenderer.send("consent:decline"),
});
