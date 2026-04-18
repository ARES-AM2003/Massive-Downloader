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

export interface WorkerMetadataUpdateMessage {
  type: 'metadata_update';
  id: string;
  totalSize: number;
}

export type WorkerOutMessage =
  | WorkerProgressMessage
  | WorkerCompletedMessage
  | WorkerPausedMessage
  | WorkerErrorMessage
  | WorkerMetadataUpdateMessage;

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
  // @ts-ignore
  const accessHandle = await fileHandle.createSyncAccessHandle();

  try {
    const headers = new Headers();
    if (startByte > 0) {
      headers.set('Range', `bytes=${startByte}-`);
    }

    let response: Response;
    try {
        response = await fetch(url, { headers, signal });
        
        // If initial GET fails (e.g. 403/404), follow user logic:
        // "only check for head and if 200 retry else skip"
        if (!response.ok && response.status !== 206) {
            console.log(`[Worker] Initial GET failed (${response.status}). Checking HEAD...`);
            const head = await fetch(url, { method: 'HEAD', signal });
            if (head.status === 200) {
                console.log(`[Worker] HEAD 200. Retrying GET...`);
                response = await fetch(url, { headers, signal });
                if (!response.ok) throw new Error(`Retry GET failed with status ${response.status}`);
            } else {
                throw new Error(`File inaccessible. HEAD status: ${head.status}`);
            }
        }
    } catch (e: any) {
        if (e.name === 'AbortError') throw e;
        // Diagnostic HEAD on network error too
        const head = await fetch(url, { method: 'HEAD', signal }).catch(() => null);
        if (head && head.status === 200) {
            response = await fetch(url, { headers, signal });
        } else {
            throw e;
        }
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    // Report real totalSize if content-length is available
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
        const totalSize = parseInt(contentLength, 10) + (startByte || 0);
        self.postMessage({
            type: 'metadata_update',
            id,
            totalSize
        } as WorkerMetadataUpdateMessage);
    }

    const reader = response.body.getReader();
    let currentByte = startByte;
    let lastReportTime = Date.now();
    const REPORT_INTERVAL_MS = 500; 

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      // Write chunk synchronously to OPFS
      const writeOptions = { at: currentByte };
      // @ts-ignore
      accessHandle.write(value, writeOptions);
      currentByte += value.byteLength;

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

    // @ts-ignore
    if (typeof accessHandle.flush === 'function') {
      accessHandle.flush();
    }

    self.postMessage({
      type: 'progress',
      id,
      downloadedSize: currentByte,
    } as WorkerProgressMessage);

    self.postMessage({ type: 'completed', id } as WorkerCompletedMessage);
  } finally {
    accessHandle.close();
  }
}
