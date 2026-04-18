import streamSaver from 'streamsaver';

export class StreamTrigger {
  /**
   * Initializes the cross-browser native download mechanism.
   * If `totalSize` cannot be explicitly determined, the download happens successfully, 
   * but the browser will only show an indefinite progress indicator until completion.
   */
  public static async triggerDownload(fileName: string, stream: ReadableStream<Uint8Array>, totalSize?: number): Promise<void> {
    // Attempt to invoke streamsaver. This will automatically route through
    // a managed ServiceWorker under the hood to bypass browser RAM limits.
    const fileStream = streamSaver.createWriteStream(fileName, {
      size: totalSize 
    });

    try {
      // Connect our dynamically generated ZIP ReadableStream directly into the streamsaver WritableStream
      await stream.pipeTo(fileStream);
    } catch (err) {
      console.error('[StreamTrigger] Fatal error streaming to disk:', err);
      // Ensure the browser doesn't get stuck in a hanging download state
      fileStream.abort();
    }
  }
}
