export class StreamCompressor {
  private worker: Worker;
  private readable: ReadableStream<Uint8Array>;
  private nextFileId = 1;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  
  // Backpressure mechanics to prevent RAM spikes
  private resumeRead!: () => void;
  private readPacer: Promise<void> | null = null;
  private activeChunksInFlight = 0;
  private MAX_IN_FLIGHT = 10; // strictly cap the amount of unwritten chunks floating in the Web Worker's mailbox

  constructor() {
    this.worker = new Worker(new URL('./zip.worker.ts', import.meta.url), { type: 'module' });

    let finalizeStream: () => void;
    let errorStream: (err: any) => void;

    // Bridge the messages from the isolated Worker back into a standard Web ReadableStream
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        // Bind the closure methods manually since we are outside the closure scope
        finalizeStream = () => controller.close();
        errorStream = (err: any) => controller.error(err);
      },
      pull: () => {
        // This is called automatically by Streamsaver (the OS WritableStream) when it 
        // finishes writing to disk and is hungry for more bytes!
        if (this.readPacer) {
          this.resumeRead();
          this.readPacer = null;
        }
      }
    }, {
      // Create a rigid physical buffer limit. If the user's Download speed (500MB/s) 
      // heavily outpaces their disk save speed (50MB/s), this stops the stream from sucking gigabytes into RAM.
      highWaterMark: 5 * 1024 * 1024, // max 5 MB buffer
      size: (chunk) => chunk.byteLength
    });

    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'data') {
        this.activeChunksInFlight = Math.max(0, this.activeChunksInFlight - 1);
        
        try {
          this.controller.enqueue(msg.chunk);
        } catch(err) {
          // Stream might already be forcefully terminated by the user canceling the download
          return;
        }

        // BACKPRESSURE: If the Streamsaver chunk pipeline is completely saturated (OS disk is too slow)
        // We initialize the `readPacer` promise lock to physically pause our inbound download fetch requests.
        // It will only be unlocked naturally when Streamsaver calls the `pull()` hook we defined above.
        if (this.controller.desiredSize !== null && this.controller.desiredSize <= 0 && !this.readPacer) {
            this.readPacer = new Promise(resolve => {
                this.resumeRead = resolve;
            });
        }

        if (msg.final) {
          finalizeStream();
          this.worker.terminate();
        }
      } else if (msg.type === 'error') {
        errorStream(msg.error);
        this.worker.terminate();
      }
    };

    // Spin up the master `Zip` instance synchronously inside the Worker's thread
    this.worker.postMessage({ type: 'init' });
  }

  public getStream(): ReadableStream<Uint8Array> {
    return this.readable;
  }

  public async addFileStream(fileName: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const fileId = this.nextFileId++;
    this.worker.postMessage({ type: 'addFile', fileId, fileName });

    const reader = stream.getReader();
    try {
      while (true) {
        // Enforce backpressure Lock (RAM flush) before reading new bytes off the network!
        if (this.readPacer) {
           await this.readPacer;
        }
        
        // Secondary Backpressure: Prevent the Web Worker's mailbox queue from bloating with 
        // hundreds of thousands of microscopic chunks before fflate digests them.
        while (this.activeChunksInFlight > this.MAX_IN_FLIGHT) {
           // Yield JS execution momentarily until the worker catches up
           await new Promise(r => setTimeout(r, 10));
        }

        const { done, value } = await reader.read();
        
        if (done) {
          const empty = new Uint8Array(0);
          this.worker.postMessage({ type: 'chunk', fileId, chunk: empty, final: true }, [empty.buffer]);
          break;
        }
        
        if (value) {
          this.activeChunksInFlight++;
          // Offload arrays into the thread utilizing zero-copy standard structured cloning!
          this.worker.postMessage({ type: 'chunk', fileId, chunk: value, final: false }, [value.buffer]);
        }
      }
    } catch (err) {
      console.error(`[StreamCompressor] Aborted streaming file ${fileName}:`, err);
      const empty = new Uint8Array(0);
      this.worker.postMessage({ type: 'chunk', fileId, chunk: empty, final: true }, [empty.buffer]);
    } finally {
      reader.releaseLock();
    }
  }

  public end() {
    this.worker.postMessage({ type: 'end' });
  }
}
