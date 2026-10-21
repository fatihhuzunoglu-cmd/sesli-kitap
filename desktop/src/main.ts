// Electron entry: starts the server and shows the app window, which is served by it.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { startServer } from './server';

if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

async function open() {
  let server;
  try {
    server = await startServer({
      port: 47800,
      libraryDir: process.env.SESLIKITAP_LIBRARY || join(app.getPath('documents'), 'Sesli Kitap'),
      staticDir: __dirname,
      version: app.getVersion(),
      log: (line) => console.log(line),
    });
  } catch (e) {
    dialog.showErrorBox('Sesli Kitap açılamadı', `Sunucu başlatılamadı: ${(e as Error).message}`);
    app.quit();
    return;
  }
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: 'Sesli Kitap',
    icon: join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#FAF7F2',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links to other sites (sources, help) open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(`http://127.0.0.1:${server.port}`)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${server.port}`)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  await win.loadURL(`http://127.0.0.1:${server.port}/`);
  win.on('closed', () => {
    win = null;
    void server.close().then(() => app.quit());
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.whenReady().then(open);
app.on('window-all-closed', () => app.quit());
