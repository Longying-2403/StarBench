// The page's way to the memory: `window.memory`, put there by the preload script beside
// `window.harness` (src/preload/index.ts).

import type { MemoryApi } from '../../shared/memory.ts'

declare global {
  interface Window {
    memory: MemoryApi
  }
}

export const memoryApi: MemoryApi = window.memory
