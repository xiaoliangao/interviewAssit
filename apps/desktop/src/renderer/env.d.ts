/// <reference types="vite/client" />
import type { AssitApi } from '../preload/index.js';

declare global {
  interface Window {
    assit: AssitApi;
  }
}
export {};
