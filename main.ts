import { DownloadManager } from './DownloadManager';
import { ZipStreamingManager, ZipDownloadRequest } from './ZipStreamingManager';

const apiUrlInput = document.getElementById('api-url') as HTMLInputElement;
const fetchApiButton = document.getElementById('fetch-api') as HTMLButtonElement;
const manualInput = document.getElementById('url-input') as HTMLTextAreaElement;
const startManualButton = document.getElementById('start-download') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

const manager = new DownloadManager();

function updateStatus(text: string, type: 'info' | 'error' | 'success' = 'info') {
    statusDiv.textContent = text;
    statusDiv.className = '';
    if (type === 'error') statusDiv.classList.add('error');
    else if (type === 'success') statusDiv.classList.add('active');
}

/**
 * Extracts a clean filename from a URL, with special handling for S3/CDN signatures.
 */
function extractFileName(urlStr: string, index: number): string {
    try {
        const url = new URL(urlStr);
        // 1. Try to get filename from the last part of the path
        let name = url.pathname.split('/').pop() || '';
        
        // 2. If it's an S3 URL, the path might be just a key. 
        // We want the actual filename part if it contains a dot.
        if (!name.includes('.') || name.length < 3) {
            name = `file-${index}`;
        }

        // Clean up common query params that might stick to the name if parsed poorly
        return decodeURIComponent(name).split('?')[0];
    } catch {
        return `file-${index}`;
    }
}

async function runDownloadFlow(urls: string[]) {
    try {
        updateStatus(`Analyzing ${urls.length} URLs (Performing discovery)...`);
        
        const rawRequests = await Promise.all(urls.map(async (urlStr, i) => {
            let fileName = extractFileName(urlStr, i);
            let totalSize = 5 * 1024 * 1024; // Default guess 5MB if discovery fails
            
            try {
                // HEAD request to get real size and content-disposition
                const head = await fetch(urlStr, { method: 'HEAD' });
                if (head.ok) {
                    const len = head.headers.get('content-length');
                    if (len) totalSize = parseInt(len, 10);
                    
                    const cd = head.headers.get('content-disposition');
                    if (cd && cd.includes('filename=')) {
                        // Extract filename from header: filename="my-video.mp4"
                        const match = cd.match(/filename=["']?([^"']+)["']?/);
                        if (match && match[1]) fileName = match[1];
                    }
                }
            } catch (e) {
                console.warn('Metadata discovery failed for:', urlStr, e);
            }

            return {
                id: `bnt-${btoa(urlStr).substring(0, 16)}-${i}`,
                url: urlStr,
                fileName: fileName,
                totalSize: totalSize
            };
        }));

        const requests = rawRequests.filter(r => r !== null);

        if (requests.length === 0) {
            updateStatus('No valid binary targets found in the URL list.', 'error');
            return;
        }

        updateStatus('Granting folder access... Please select a destination folder.');
        
        try {
            await manager.startDownloads(requests);
            updateStatus(`Success! Streaming ${requests.length} files to disk. Check your local folder.`, 'success');
        } catch (err: any) {
            // Check for File System Access API support
            if (err.message && err.message.includes('File System Access API is not supported')) {
                updateStatus('Native folder access unavailable. Starting ZIP Streaming fallback...', 'info');
                
                const zipManager = new ZipStreamingManager();
                const zipRequests: ZipDownloadRequest[] = requests.map(r => ({
                    url: r.url,
                    fileName: r.fileName
                }));

                await zipManager.streamArchive('bnt-export.zip', zipRequests);
                updateStatus('ZIP Streaming started! Your browser will prompt for a single ZIP file save.', 'success');
            } else {
                throw err;
            }
        }
    } catch (err: any) {
        updateStatus(`Error: ${err.message}`, 'error');
        console.error(err);
    }
}

// Handler for API Fetch
fetchApiButton.addEventListener('click', async () => {
    const url = apiUrlInput.value.trim();
    if (!url) {
        updateStatus('Please enter a valid API Endpoint URL.', 'error');
        return;
    }

    try {
        updateStatus(`Fetching presigned URLs from ${new URL(url).hostname}...`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`API returned ${response.status}: ${response.statusText}`);
        
        const data = await response.json();
        const urls = data.presignedUrls;

        if (!Array.isArray(urls) || urls.length === 0) {
            throw new Error('Invalid response format: "presignedUrls" array not found or empty.');
        }

        await runDownloadFlow(urls);
    } catch (err: any) {
        updateStatus(`API Fetch Failed: ${err.message}`, 'error');
    }
});

// Handler for Manual Input
startManualButton.addEventListener('click', async () => {
    const rawInput = manualInput.value.trim();
    if (!rawInput) {
        updateStatus('Please enter at least one URL.', 'error');
        return;
    }

    const urls = rawInput.split(',').map(u => u.trim()).filter(u => u.length > 0);
    await runDownloadFlow(urls);
});
