import { StreamCompressor } from './StreamCompressor';
import { StreamTrigger } from './StreamTrigger';

export interface ZipDownloadRequest {
  url: string;
  fileName: string;
  opfsId?: string;
}

export class ZipStreamingManager {
  private _isBusy = false;

  public get isBusy(): boolean {
    return this._isBusy;
  }

  /**
   * Reads from OPFS if opfsId is provided, otherwise fetches from URL.
   */
  public async streamArchive(archiveName: string, requests: ZipDownloadRequest[]) {
    this._isBusy = true;
    
    // 1. Prepare Compressor 
    const compressor = new StreamCompressor();
    const zipStream = compressor.getStream();

    // 2. Trigger the OS download immediately. 
    const triggerPromise = StreamTrigger.triggerDownload(archiveName, zipStream).catch(console.error);

    try {
        const rootDir = await navigator.storage.getDirectory();

        // 3. Pump bytes into the compressor
        for (const req of requests) {
            try {
                let stream: ReadableStream<Uint8Array> | null = null;

                if (req.opfsId) {
                    try {
                        const fileHandle = await rootDir.getFileHandle(req.opfsId);
                        const file = await fileHandle.getFile();
                        stream = file.stream();
                        console.log(`[ZIPManager] Streaming ${req.fileName} from OPFS...`);
                    } catch (e) {
                        console.warn(`[ZIPManager] Failed to read ${req.opfsId} from OPFS, falling back to fetch.`, e);
                    }
                }

                if (!stream) {
                    console.log(`[ZIPManager] Fetching ${req.fileName} from network...`);
                    const response = await fetch(req.url);
                    if (!response.ok || !response.body) {
                        console.warn(`[ZIPManager] Failed to fetch ${req.url}. Skipping.`);
                        continue;
                    }
                    stream = response.body;
                }

                await compressor.addFileStream(req.fileName, stream);
            } catch (err) {
                console.error(`[ZIPManager] Error adding ${req.fileName} to archive:`, err);
            }
        }

        // 4. Finalize the Archive
        console.log(`[ZIPManager] Finalizing Central Directory.`);
        compressor.end();
        
        await triggerPromise;
    } finally {
        this._isBusy = false;
    }
  }
}
