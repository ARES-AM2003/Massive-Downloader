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
  private activeTransfers = new Set<string>();
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private concurrencyLimit = 3;
  private isPaused = false;
  
  public onProgress?: (stats: { 
    totalFiles: number; 
    completedFiles: number; 
    stagedFiles: number;    
    transferredFiles: number; 
    totalBytes: number; 
    downloadedBytes: number; 
    activeFiles: string[];
    activeTransfers: string[];
  }) => void;

  private progressAnimationFrame: number | null = null;

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
    this.reportProgress();
  }

  public async startDownloads(requests: DownloadRequest[]): Promise<void> {
    const isNativeSupported = 'showDirectoryPicker' in window;

    // 1. Quota Check
    const totalRequiredSize = requests.reduce((sum, req) => sum + req.totalSize, 0);
    const estimate = await navigator.storage.estimate();
    if (estimate.quota !== undefined && estimate.usage !== undefined) {
      const available = estimate.quota - estimate.usage;
      
      // If Native FS is supported, we only need space for concurrent downloads + buffer (e.g. 1GB)
      // because we delete files from OPFS after moving to local disk.
      const bufferSize = 1024 * 1024 * 1024; // 1GB safety buffer
      const requiredBuffer = isNativeSupported ? Math.min(totalRequiredSize, bufferSize) : totalRequiredSize;

      if (available < requiredBuffer * 1.1) {
        const availMB = (available / (1024 * 1024)).toFixed(0);
        const reqMB = (requiredBuffer / (1024 * 1024)).toFixed(0);
        const error = new Error(`Insufficient storage quota. Available: ${availMB}MB, Required: ${reqMB}MB.`);
        (error as any).quotaExceeded = true;
        (error as any).available = available;
        (error as any).required = totalRequiredSize;
        throw error;
      }
    }

    // 2. Prompt for Directory (only if supported and not already set)
    if (isNativeSupported && !this.directoryHandle) {
      try {
        const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
        if (handle) {
          this.directoryHandle = handle;
          console.log('Directory handle acquired successfully:', handle.name);
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          console.warn('User cancelled directory selection.');
          // We can still proceed with OPFS-only staging if we want, 
          // but usually Abort means stop. Let's still add to queue.
        } else {
          throw err;
        }
      }
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
    if (this.isPaused) return;

    // Check if we can proceed without directory handle (for OPFS-only staging)
    // In Fallback/ZIP mode, we don't need directoryHandle yet.
    
    while (this.activeWorkers.size < this.concurrencyLimit && this.taskQueue.length > 0) {
      const nextId = this.taskQueue.shift()!;
      const metadata = await stateStore.getFileMetadata(nextId);

      if (!metadata) continue;

      if (metadata.status === 'completed') {
        // Needs sequence: OPFS -> Local FS (only if handle available)
        if (this.directoryHandle) {
          this.transferToLocalDisk(metadata);
        } else {
          // Stay in completed state in OPFS until ZIP finalized or Handle provided
          continue;
        }
      } else {
        // Needs downloading
        this.startWorker(metadata);
      }
    }
    
    this.reportProgress();
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
          this.reportProgress();
          break;
        case 'metadata_update':
          await stateStore.upsertFileMetadata({
            ...metadata,
            totalSize: msg.totalSize,
          });
          this.reportProgress();
          break;
        case 'completed':
          await stateStore.upsertFileMetadata({
            ...metadata,
            status: 'completed',
          });
          this.activeWorkers.delete(metadata.id);
          worker.terminate();
          // Initiate move to disk if possible
          if (this.directoryHandle) {
            await this.transferToLocalDisk(metadata);
          }
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
    this.activeTransfers.add(metadata.id);
    this.reportProgress();
    
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
    } finally {
      this.activeTransfers.delete(metadata.id);
      this.reportProgress();
    }
  }

  public togglePause() {
    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      // Pause all active workers
      for (const [id, worker] of this.activeWorkers) {
        worker.postMessage({ type: 'pause', id } as WorkerInMessage);
      }
    } else {
      // Resume
      this.processQueue();
    }
  }

  public isBusy(): boolean {
    return this.activeWorkers.size > 0 || this.taskQueue.length > 0;
  }

  public getPaused(): boolean {
    return this.isPaused;
  }

  public setDirectoryHandle(handle: FileSystemDirectoryHandle) {
    this.directoryHandle = handle;
    this.processQueue();
  }

  public hasDirectoryHandle(): boolean {
    return this.directoryHandle !== null;
  }

  public reportProgress() {
    if (!this.onProgress || this.progressAnimationFrame !== null) return;

    this.progressAnimationFrame = requestAnimationFrame(async () => {
      this.progressAnimationFrame = null;
      const all = await stateStore.getAll();
      
      const staged = all.filter(f => f.status === 'completed');
      const transferred = all.filter(f => f.status === 'transferred');
      
      const stats = {
        totalFiles: all.length,
        completedFiles: staged.length + transferred.length,
        stagedFiles: staged.length,
        transferredFiles: transferred.length,
        totalBytes: all.reduce((acc, f) => acc + f.totalSize, 0),
        downloadedBytes: all.reduce((acc, f) => acc + f.downloadedSize, 0),
        activeFiles: Array.from(this.activeWorkers.keys()),
        activeTransfers: Array.from(this.activeTransfers)
      };

      this.onProgress?.(stats);
    });
  }
}
