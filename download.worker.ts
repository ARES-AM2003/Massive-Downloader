/// <reference lib="webworker" />

export interface WorkerStartMessage {
  type: 'start';
  id: string;
  url: string;
  startByte: number;
}

export interface WorkerPauseMessage {
  type: 'pause';
  id: string;
}

export type WorkerInMessage = WorkerStartMessage | WorkerPauseMessage;

export interface WorkerProgressMessage {
  type: 'progress';
  id: string;
  downloadedSize: number;
}

export interface WorkerCompletedMessage {
  type: 'completed';
  id: string;
}

export interface WorkerPausedMessage {
  type: 'paused';
  id: string;
}

export interface WorkerErrorMessage {
  type: 'error';
  id: string;
  error: string;
}

export type WorkerOutMessage =
  | WorkerProgressMessage
  | WorkerCompletedMessage
  | WorkerPausedMessage
  | WorkerErrorMessage;

// State tracking within the worker to allow pausing
const activeTasks = new Map<string, { abortController: AbortController }>();

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'start') {
    const { id, url, startByte } = msg;

    if (activeTasks.has(id)) {
      return; // Already running
    }

    const abortController = new AbortController();
    activeTasks.set(id, { abortController });

    try {
      await processDownload(id, url, startByte, abortController.signal);
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        self.postMessage({ type: 'paused', id } as WorkerPausedMessage);
      } else {
        self.postMessage({
          type: 'error',
          id,
          error: err.message || String(err),
        } as WorkerErrorMessage);
      }
    } finally {
      activeTasks.delete(id);
    }
  } else if (msg.type === 'pause') {
    const task = activeTasks.get(msg.id);
    if (task) {
      task.abortController.abort();
    }
  }
};

async function processDownload(
  id: string,
  url: string,
  startByte: number,
  signal: AbortSignal
) {
  // Get OPFS root
  const rootDir = await navigator.storage.getDirectory();
  
  // Use the ID as the temporary filename in OPFS
  const fileHandle = await rootDir.getFileHandle(id, { create: true });
  
  // Create SyncAccessHandle for synchronous I/O
  // This is only available in a Web Worker, not the main thread!
  // @ts-ignore - TS may not have full typing for createSyncAccessHandle in all versions
  const accessHandle = await fileHandle.createSyncAccessHandle();

  try {
    const headers = new Headers();
    if (startByte > 0) {
      headers.set('Range', `bytes=${startByte}-`);
    }

    const response = await fetch(url, { headers, signal });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    let currentByte = startByte;
    let lastReportTime = Date.now();
    const REPORT_INTERVAL_MS = 500; // Report progress at most twice a second

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Write chunk synchronously to OPFS
      // Ensure we cast to any if typings are missing
      const writeOptions = { at: currentByte };
      // @ts-ignore
      accessHandle.write(value, writeOptions);
      currentByte += value.byteLength;

      // Throttle progress reporting to the main thread
      const now = Date.now();
      if (now - lastReportTime > REPORT_INTERVAL_MS) {
        self.postMessage({
          type: 'progress',
          id,
          downloadedSize: currentByte,
        } as WorkerProgressMessage);
        lastReportTime = now;
      }
    }

    // Final flush to ensure writing is flushed to disk
    // @ts-ignore
    if (typeof accessHandle.flush === 'function') {
      accessHandle.flush();
    }

    // Report final progress
    self.postMessage({
      type: 'progress',
      id,
      downloadedSize: currentByte,
    } as WorkerProgressMessage);

    self.postMessage({ type: 'completed', id } as WorkerCompletedMessage);
  } finally {
    // Release the OPFS lock
    accessHandle.close();
  }
}
