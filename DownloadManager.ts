import { stateStore, FileDownloadMetadata } from './StateStore';
import { WorkerInMessage, WorkerOutMessage } from './download.worker';

export interface DownloadRequest {
  id: string;
  url: string;
  fileName: string;
  relativePath?: string; // e.g. "photos/2023"
  totalSize: number;
}

export class DownloadManager {
  private taskQueue: string[] = [];
  private activeWorkers = new Map<string, Worker>();
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private concurrencyLimit = 3;

  constructor() {
    this.hydrateFromStore();
  }

  private async hydrateFromStore() {
    const allStates = await stateStore.getAll();
    for (const state of allStates) {
      if (state.status === 'downloading' || state.status === 'pending') {
        // Re-queue items that were abruptly stopped
        await stateStore.upsertFileMetadata({ ...state, status: 'pending' });
        this.taskQueue.push(state.id);
      } else if (state.status === 'completed') {
        // Files that finished OPFS download but haven't been transferred
        this.taskQueue.push(state.id);
      }
    }
  }

  public async startDownloads(requests: DownloadRequest[]): Promise<void> {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API is not supported in this browser. Please use a compatible browser like Chrome, Edge, or Opera.');
    }

    // 1. Quota Check (require 1.1x total size)
    const totalRequiredSize = requests.reduce((sum, req) => sum + req.totalSize, 0);
    const estimate = await navigator.storage.estimate();
    if (estimate.quota !== undefined && estimate.usage !== undefined) {
      const available = estimate.quota - estimate.usage;
      if (available < totalRequiredSize * 1.1) {
        throw new Error('Insufficient storage quota available.');
      }
    }

    // 2. Prompt for Directory
    try {
      this.directoryHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn('User cancelled directory selection.');
        return;
      }
      throw err;
    }

    // 3. Register tasks in DB
    for (const req of requests) {
      const existing = await stateStore.getFileMetadata(req.id);
      if (!existing || (existing.status !== 'completed' && existing.status !== 'transferred')) {
        await stateStore.upsertFileMetadata({
          id: req.id,
          url: req.url,
          fileName: req.fileName,
          relativePath: req.relativePath || '',
          totalSize: req.totalSize,
          downloadedSize: existing ? existing.downloadedSize : 0,
          status: 'pending',
          timestamp: Date.now(),
        });
        if (!this.taskQueue.includes(req.id)) {
          this.taskQueue.push(req.id);
        }
      }
    }

    // 4. Start processing
    this.processQueue();
  }

  private async processQueue() {
    if (!this.directoryHandle) return;

    while (this.activeWorkers.size < this.concurrencyLimit && this.taskQueue.length > 0) {
      const nextId = this.taskQueue.shift()!;
      const metadata = await stateStore.getFileMetadata(nextId);

      if (!metadata) continue;

      if (metadata.status === 'completed') {
        // Needs sequence: OPFS -> Local FS
        this.transferToLocalDisk(metadata);
      } else {
        // Needs downloading
        this.startWorker(metadata);
      }
    }
  }

  private startWorker(metadata: FileDownloadMetadata) {
    const worker = new Worker(new URL('./download.worker.ts', import.meta.url), { type: 'module' });
    this.activeWorkers.set(metadata.id, worker);

    worker.onmessage = async (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;

      switch (msg.type) {
        case 'progress':
          await stateStore.upsertFileMetadata({
            ...metadata,
            downloadedSize: msg.downloadedSize,
            status: 'downloading',
          });
          break;
        case 'completed':
          await stateStore.upsertFileMetadata({
            ...metadata,
            status: 'completed',
          });
          this.activeWorkers.delete(metadata.id);
          worker.terminate();
          // Initiate move to disk
          await this.transferToLocalDisk(metadata);
          this.processQueue();
          break;
        case 'error':
          await stateStore.upsertFileMetadata({
            ...metadata,
            status: 'error',
            errorMessage: msg.error,
          });
          this.activeWorkers.delete(metadata.id);
          worker.terminate();
          this.processQueue();
          break;
        case 'paused':
          await stateStore.upsertFileMetadata({
            ...metadata,
            status: 'paused',
          });
          this.activeWorkers.delete(metadata.id);
          worker.terminate();
          this.processQueue();
          break;
      }
    };

    worker.postMessage({
      type: 'start',
      id: metadata.id,
      url: metadata.url,
      startByte: metadata.downloadedSize,
    } as WorkerInMessage);
  }

  private async getTargetDirectoryHandle(relativePath: string): Promise<FileSystemDirectoryHandle> {
    if (!this.directoryHandle) throw new Error('Root directory handle not set');
    
    let currentHandle = this.directoryHandle;
    if (relativePath) {
      // Create nested subdirectories sequentially
      const parts = relativePath.split('/').filter(p => p.length > 0);
      for (const part of parts) {
        currentHandle = await currentHandle.getDirectoryHandle(part, { create: true });
      }
    }
    return currentHandle;
  }

  private async transferToLocalDisk(metadata: FileDownloadMetadata) {
    try {
      const rootDir = await navigator.storage.getDirectory();
      const opfsFileHandle = await rootDir.getFileHandle(metadata.id);
      const opfsFile = await opfsFileHandle.getFile();

      // Get target directory, resolving relative paths
      const targetDirHandle = await this.getTargetDirectoryHandle(metadata.relativePath);

      // Create target file handle in the user-selected local directory
      const localFileHandle = await targetDirHandle.getFileHandle(metadata.fileName, { create: true });
      const writable = await localFileHandle.createWritable();

      // Stream the data from OPFS to Native File System
      // pipeTo automatically handles closing the WritableStream on finish
      await opfsFile.stream().pipeTo(writable);

      // Clean up OPFS cache
      await rootDir.removeEntry(metadata.id);

      // Mark as fully complete
      await stateStore.upsertFileMetadata({
        ...metadata,
        status: 'transferred',
      });

    } catch (err: any) {
      console.error(`Failed to transfer file ${metadata.id} to local disk:`, err);
      await stateStore.upsertFileMetadata({
        ...metadata,
        status: 'error',
        errorMessage: err.message || String(err),
      });
    }
  }

  public pauseDownload(id: string) {
    const worker = this.activeWorkers.get(id);
    if (worker) {
      worker.postMessage({ type: 'pause', id } as WorkerInMessage);
    }
  }
}
