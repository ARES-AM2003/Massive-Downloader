import { Zip, ZipPassThrough } from 'fflate';

let zipInstance: Zip | null = null;
const activeFiles = new Map<number, ZipPassThrough>();

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'init') {
    zipInstance = new Zip((err, data, final) => {
      if (err) {
        self.postMessage({ type: 'error', error: err });
      } else {
        // Transfer the generated ZIP chunk back to the main thread securely 
        // without copying it in memory.
        self.postMessage({ type: 'data', chunk: data, final }, [data.buffer]);
      }
    });
  } else if (msg.type === 'addFile') {
    if (!zipInstance) return;
    // ZipPassThrough pushes uncompressed data streams accurately 
    const fileZipObj = new ZipPassThrough(msg.fileName);
    zipInstance.add(fileZipObj);
    activeFiles.set(msg.fileId, fileZipObj);
  } else if (msg.type === 'chunk') {
    const fileZipObj = activeFiles.get(msg.fileId);
    if (fileZipObj) {
      fileZipObj.push(msg.chunk, msg.final);
      if (msg.final) {
        activeFiles.delete(msg.fileId);
      }
    }
  } else if (msg.type === 'end') {
    if (zipInstance) {
      zipInstance.end();
    }
  }
};
