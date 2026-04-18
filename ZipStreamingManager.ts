import { StreamCompressor } from './StreamCompressor';
import { StreamTrigger } from './StreamTrigger';

export interface ZipDownloadRequest {
  url: string;
  fileName: string;
}

export class ZipStreamingManager {
  /**
   * Initiates the sequence:
   * 1. Creates an empty ZIP stream.
   * 2. Prompts the browser's "Save As" directly out of the empty stream.
   * 3. Sequentially downloads each photo, adding its chunks to the ZIP.
   * 4. Closes the stream, finalizing the ZIP Central Directory.
   */
  public async streamArchive(archiveName: string, requests: ZipDownloadRequest[]) {
    // 1. Prepare Compressor 
    const compressor = new StreamCompressor();
    const zipStream = compressor.getStream();

    // 2. Trigger the OS download immediately. 
    // We do NOT `await` this here, because it's a long-running pipeline!
    // The promise will resolve when all bytes are entirely finished piping.
    StreamTrigger.triggerDownload(archiveName, zipStream).catch(console.error);

    // 3. Sequentially fetch files and pump bytes into the compressor
    for (const req of requests) {
      try {
        console.log(`[ZIPManager] Downloading ${req.fileName}...`);
        const response = await fetch(req.url);
        
        if (!response.ok || !response.body) {
          console.warn(`[ZIPManager] Failed to fetch ${req.url} (Status: ${response.status}). Skipping.`);
          continue;
        }

        await compressor.addFileStream(req.fileName, response.body);
      } catch (err) {
        console.error(`[ZIPManager] Network error during fetch of ${req.url}:`, err);
        // Continue with the rest of the stream
      }
    }

    // 4. Finalize the Archive
    console.log(`[ZIPManager] All items processed. Finalizing Central Directory.`);
    compressor.end();
  }
}
