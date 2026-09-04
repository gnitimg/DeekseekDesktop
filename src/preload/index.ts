/**
 * Preload: exposes a minimal, typed desktop bridge to the renderer. The dsh host
 * owns all agent behavior; this carries the host URL, the RPC/stream proxy, and
 * the plugin marketplace API (proxied through main to avoid renderer CORS).
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  dsh: {
    getUrl: (): Promise<string | undefined> => ipcRenderer.invoke('dsh:url'),
    rpc: (method: string, args: unknown): Promise<unknown> => ipcRenderer.invoke('dsh:rpc', method, args),
    stream: {
      open: (endpoint: string, args: unknown): Promise<string | undefined> => ipcRenderer.invoke('dsh:stream:open', endpoint, args),
      cancel: (streamId: string): Promise<void> => ipcRenderer.invoke('dsh:stream:cancel', streamId),
      onFrame: (handler: (frame: unknown) => void): (() => void) => {
        const listener = (_event: unknown, frame: unknown): void => handler(frame)
        ipcRenderer.on('dsh:stream:frame', listener)
        return () => ipcRenderer.off('dsh:stream:frame', listener)
      },
    },
  },
  plugins: {
    list: (): Promise<unknown> => ipcRenderer.invoke('plugins:list'),
    install: (spec: string): Promise<string> => ipcRenderer.invoke('plugins:install', spec),
  },
  settings: {
    read: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:read'),
    write: (env: Record<string, string>): Promise<void> => ipcRenderer.invoke('settings:write', env),
    appearance: (value: 'light' | 'dark' | 'system'): Promise<void> => ipcRenderer.invoke('settings:appearance', value),
  },
  project: {
    chooseDirectory: (): Promise<string | undefined> => ipcRenderer.invoke('project:choose-directory'),
    environment: (path: string): Promise<unknown> => ipcRenderer.invoke('project:environment', path),
    openTerminal: (path: string): Promise<void> => ipcRenderer.invoke('project:open-terminal', path),
  },
  attachments: {
    chooseImages: (): Promise<Array<{ name: string, mediaType: string, data: string }>> => ipcRenderer.invoke('attachments:choose-images'),
  },
}

contextBridge.exposeInMainWorld('desktop', api)

export type DesktopApi = typeof api
