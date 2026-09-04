/** Canonical IPC channel names. Both sides import from here so a typo cannot diverge. */
export const IPC = {
  // Projects
  projectsList: 'projects:list',
  projectsCreate: 'projects:create',
  projectsRename: 'projects:rename',
  projectsDelete: 'projects:delete',

  // Recordings
  recordingsList: 'recordings:list',
  recordingsGet: 'recordings:get',
  recordingsRename: 'recordings:rename',
  recordingsDelete: 'recordings:delete',
  recordingsSaveTranscript: 'recordings:saveTranscript',
  recordingsSearch: 'recordings:search',

  // Capture
  recordStart: 'recording:start',
  recordPcm: 'recording:pcm',
  recordPause: 'recording:pause',
  recordResume: 'recording:resume',
  recordStop: 'recording:stop',
  recordCancel: 'recording:cancel',
  recordState: 'recording:state',

  // File import
  importBegin: 'import:begin',
  importPcm: 'import:pcm',
  importFinish: 'import:finish',
  importCancel: 'import:cancel',

  // Transcription
  transcriptionRetry: 'transcription:retry',
  transcriptionAccept: 'transcription:accept',
  transcriptionUpdate: 'transcription:update',

  // Model management
  modelStatus: 'model:status',
  modelDownload: 'model:download',
  modelSelect: 'model:select',
  modelProgress: 'model:progress',

  // Shell integration
  shellReveal: 'shell:reveal',
  shellOpenTranscript: 'shell:openTranscript',
  shellOpenProjectDir: 'shell:openProjectDir',
  shellRootDir: 'shell:rootDir'
} as const

/** Sample rate the renderer must resample to before sending PCM. Whisper requires 16 kHz mono. */
export const SAMPLE_RATE = 16000
export const CHANNELS = 1
