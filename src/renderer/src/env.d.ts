import type { HarnessApi } from '../../shared/types.ts'

declare global {
  interface Window {
    harness: HarnessApi
  }
}
