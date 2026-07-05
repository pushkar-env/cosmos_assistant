import type { CosmosApi } from '../../preload/index'

declare global {
  interface Window {
    cosmos: CosmosApi
  }
}

export {}
