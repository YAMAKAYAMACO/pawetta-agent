'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, backgroundColor: '#00000000' });
    await win.loadFile(path.join(__dirname, '..', 'build', 'icon.html'));
    await new Promise(resolve => setTimeout(resolve, 250));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
    await fs.writeFile(path.join(__dirname, '..', 'build', 'icon.png'), image.toPNG());
    win.destroy();
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
