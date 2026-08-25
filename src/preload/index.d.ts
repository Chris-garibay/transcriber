import type { TranscriberApi } from './index'

declare global {
  interface Window {
    api: TranscriberApi
  }
}

export {}
