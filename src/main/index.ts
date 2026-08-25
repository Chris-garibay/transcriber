import { app, shell, BrowserWindow, systemPreferences, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'
import { ensureRoot } from './storage/projects'
import { queue } from './transcription/queue'
import { recorder } from './recorder/session'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Transcriber',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#111318',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Electron security baseline: the renderer gets no Node access at all and
      // reaches the main process only through the frozen preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for the preload bridge to use contextBridge with ESM output
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Without this the variable keeps pointing at a destroyed window, and any
  // later use throws "Object has been destroyed".
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Any attempt to open a new window goes to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * macOS gates microphone access at the OS level and returns an empty device
 * list until consent is granted, so ask before the renderer tries to capture.
 * Windows has no equivalent prompt; getUserMedia handles it there.
 */
async function requestMicrophoneAccess(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
  } catch (err) {
    console.error('[main] microphone permission check failed:', err)
  }
}

/**
 * A single instance keeps two windows from writing to the same recording
 * directory: concurrent runs could allocate the same recording id or transcribe
 * the same file twice.
 *
 * The lock is only taken in a packaged build. In development a stale instance
 * left running would otherwise swallow every relaunch and quietly show the old
 * build, which looks exactly like "my changes did nothing".
 */
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Launching again while an instance is alive focuses it. On macOS the app
  // outlives its window, so there may be nothing to focus and we reopen.
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.chrisgaribay.transcriber')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    await ensureRoot()
    registerIpc()
    await requestMicrophoneAccess()

    createWindow()

    // Pick up anything a previous run left mid-transcription.
    void queue.resumePending().catch((err) => console.error('[main] resume failed:', err))

    app.on('activate', () => {
      const live = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      if (live.length === 0) createWindow()
    })
  })
}

/**
 * Never let the app exit with audio still buffered. Stopping the recorder
 * flushes and closes the WAV, so the capture survives the quit.
 */
let finalising = false
app.on('before-quit', (event) => {
  if (!recorder.active || finalising) return
  event.preventDefault()
  finalising = true

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Save and quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'A recording is still in progress.',
    detail: 'Quitting will stop the recording and save what has been captured so far.'
  })

  if (choice === 1) {
    finalising = false
    return
  }

  void recorder
    .stop()
    .catch((err) => console.error('[main] failed to finalise recording on quit:', err))
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
