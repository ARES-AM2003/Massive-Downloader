import { DownloadManager, DownloadRequest } from './DownloadManager';
import { ZipStreamingManager, ZipDownloadRequest } from './ZipStreamingManager';
import { stateStore } from './StateStore';

const apiUrlInput = document.getElementById('api-url') as HTMLInputElement;
const fetchApiButton = document.getElementById('fetch-api') as HTMLButtonElement;
const manualInput = document.getElementById('url-input') as HTMLTextAreaElement;
const startManualButton = document.getElementById('start-download') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

// Dashboard Elements
const dashboard = document.getElementById('dashboard') as HTMLDivElement;
const statFiles = document.getElementById('stat-files') as HTMLDivElement;
const statSpeed = document.getElementById('stat-speed') as HTMLDivElement;
const progressPercent = document.getElementById('progress-percent') as HTMLSpanElement;
const progressFill = document.getElementById('progress-fill') as HTMLDivElement;
const activeFilesList = document.getElementById('active-files-list') as HTMLDivElement;
const pauseResumeBtn = document.getElementById('pause-resume-btn') as HTMLButtonElement;
const finalizeZipBtn = document.getElementById('finalize-zip-btn') as HTMLButtonElement;
const directZipBtn = document.getElementById('direct-zip-btn') as HTMLButtonElement;
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;

const manager = new DownloadManager();
let zipManager: ZipStreamingManager | null = null;
let currentRequests: DownloadRequest[] = [];
let lastBytes: number | null = null;
let lastTime = Date.now();
let speedSamples: number[] = [];

function updateStatus(text: string, type: 'info' | 'error' | 'success' = 'info') {
    statusDiv.textContent = text;
    statusDiv.className = '';
    if (type === 'error') statusDiv.classList.add('error');
    else if (type === 'success') statusDiv.classList.add('active');
}

/**
 * Extracts a clean filename from a URL
 */
function extractFileName(urlStr: string, index: number): string {
    try {
        const url = new URL(urlStr);
        let name = url.pathname.split('/').pop() || '';
        if (!name.includes('.') || name.length < 3) {
            name = `file-${index}`;
        }
        return decodeURIComponent(name).split('?')[0];
    } catch {
        return `file-${index}`;
    }
}

// 1. Dashboard Logic
manager.onProgress = (stats) => {
    dashboard.style.display = 'block';
    statFiles.textContent = `${stats.completedFiles} / ${stats.totalFiles}`;
    
    // Robust speed calculation (moving average)
    const now = Date.now();
    if (lastBytes === null) {
        lastBytes = stats.downloadedBytes;
        lastTime = now;
        return;
    }

    const duration = (now - lastTime) / 1000;
    if (duration >= 1) {
        const bytesDiff = Math.max(0, stats.downloadedBytes - lastBytes);
        const instantSpeed = bytesDiff / duration;
        
        speedSamples.push(instantSpeed);
        if (speedSamples.length > 5) speedSamples.shift();
        
        const avgSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        
        statSpeed.textContent = avgSpeed > 1024 * 1024 
            ? `${(avgSpeed / (1024 * 1024)).toFixed(1)} MB/s` 
            : `${(avgSpeed / 1024).toFixed(0)} KB/s`;
            
        lastBytes = stats.downloadedBytes;
        lastTime = now;
    }

    // Switch progress to file-count completion for better UX
    const percent = stats.totalFiles > 0 ? (stats.completedFiles / stats.totalFiles) * 100 : 0;
    progressPercent.textContent = `${percent.toFixed(1)}%`;
    progressFill.style.width = `${percent}%`;

    // Active files preview (Downloading + Saving)
    const downloadingItems = stats.activeFiles.map(id => `
        <div class="active-file-item">
            <span>${id.substring(0, 20)}...</span>
            <span style="color: var(--accent);">Downloading</span>
        </div>
    `);
    
    const savingItems = stats.activeTransfers.map(id => `
        <div class="active-file-item">
            <span style="max-width: 150px; overflow: hidden; text-overflow: ellipsis;">${id.substring(0, 20)}...</span>
            <span style="color: #4ade80;">Saving to Folder</span>
        </div>
    `);

    activeFilesList.innerHTML = [...downloadingItems, ...savingItems].join('');

    // Accurate Status Reporting
    if (stats.totalFiles > 0) {
        if (stats.transferredFiles === stats.totalFiles) {
            updateStatus('All files transferred successfully!', 'success');
            finalizeZipBtn.style.display = 'none';
        } else if (manager.hasDirectoryHandle()) {
            // Priority: Show transfer status if handle is active
            if (stats.completedFiles === stats.totalFiles) {
                updateStatus(`Saving ${stats.stagedFiles} remaining files to your folder...`, 'info');
                finalizeZipBtn.style.display = 'flex';
            } else {
                updateStatus(`Downloading & Transferring... ${stats.transferredFiles} saved, ${stats.stagedFiles} staged.`, 'info');
            }
        } else if (stats.completedFiles === stats.totalFiles) {
            // Staged but no handle
            finalizeZipBtn.style.display = 'flex';
            updateStatus(`All items are ready in browser cache! Click "Finalize ZIP" or pick a folder to save.`, 'info');
        } else {
            // Still downloading to OPFS
            updateStatus(`Downloading... ${stats.completedFiles} of ${stats.totalFiles} items processed.`, 'info');
        }
    }
};

// 2. Control Handlers
pauseResumeBtn.addEventListener('click', () => {
    manager.togglePause();
    const isPaused = manager.getPaused();
    pauseResumeBtn.innerHTML = isPaused 
        ? `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Resume`
        : `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg> Pause`;
    pauseResumeBtn.classList.toggle('paused', isPaused);
});

resetBtn.addEventListener('click', async () => {
    if (confirm('Clear all progress and stored files?')) {
        await stateStore.clearAll();
        const root = await navigator.storage.getDirectory();
        // Clear OPFS
        for await (const name of (root as any).keys()) {
            await root.removeEntry(name, { recursive: true });
        }
        window.location.reload();
    }
});

finalizeZipBtn.addEventListener('click', async () => {
    if (!zipManager) zipManager = new ZipStreamingManager();
    
    finalizeZipBtn.disabled = true;
    updateStatus('Generating ZIP from cache... Please wait.', 'info');
    
    const zipRequests: ZipDownloadRequest[] = currentRequests.map(r => ({
        url: r.url,
        fileName: r.fileName,
        opfsId: r.id
    }));

    try {
        await zipManager.streamArchive('bnt-export.zip', zipRequests);
        updateStatus('Success! ZIP file created.', 'success');
    } catch (err: any) {
        updateStatus(`ZIP Error: ${err.message}`, 'error');
    } finally {
        finalizeZipBtn.disabled = false;
    }
});

directZipBtn.addEventListener('click', async () => {
    if (!zipManager) zipManager = new ZipStreamingManager();
    
    dashboard.style.display = 'block';
    directZipBtn.disabled = true;
    updateStatus('Streaming directly from network... Progress cannot be resumed if tab closes.', 'info');
    
    const zipRequests: ZipDownloadRequest[] = currentRequests.map(r => ({
        url: r.url,
        fileName: r.fileName
        // No opfsId -> will use fetch
    }));

    try {
        await zipManager.streamArchive('bnt-export.zip', zipRequests);
        updateStatus('Success! Direct ZIP created.', 'success');
    } catch (err: any) {
        updateStatus(`Direct ZIP Error: ${err.message}`, 'error');
    } finally {
        directZipBtn.disabled = false;
        directZipBtn.style.display = 'none';
    }
});

// 3. Main Flow
async function runDownloadFlow(urls: string[]) {
    try {
        // Reset stats tracking
        lastBytes = null;
        lastTime = Date.now();
        speedSamples = [];

        updateStatus(`Initializing ${urls.length} downloads...`);
        
        currentRequests = urls.map((urlStr, i) => ({
            id: `bnt-${btoa(urlStr).substring(0, 16)}-${i}`,
            url: urlStr,
            fileName: extractFileName(urlStr, i),
            totalSize: 0 // Discovered dynamically by workers
        }));

        const isNativeSupported = 'showDirectoryPicker' in window;
        
        if (isNativeSupported) {
            updateStatus(`Ready to save ${currentRequests.length} files. Please select a destination folder.`, 'info');
            await manager.startDownloads(currentRequests);
            if (manager.hasDirectoryHandle()) {
                updateStatus('Destination confirmed! Starting transfers...', 'success');
                manager.reportProgress();
            } else {
                updateStatus('Folder selection skipped. Staging files to browser cache instead...', 'info');
            }
        } else {
            updateStatus('Native folder access unavailable. Using browser cache staging.', 'info');
            await manager.startDownloads(currentRequests); 
        }
    } catch (err: any) {
        if (err.quotaExceeded) {
            dashboard.style.display = 'block';
            directZipBtn.style.display = 'flex';
            updateStatus(`Quota full (${(err.available / (1024 * 1024)).toFixed(0)} MB left). Try Direct Download?`, 'error');
        } else {
            updateStatus(`Error: ${err.message}`, 'error');
        }
        console.error(err);
    }
}

// 4. Tab-Close Protection
window.addEventListener('beforeunload', (e) => {
    const isBusy = manager.isBusy() || (zipManager && zipManager.isBusy);
    if (isBusy) {
        e.preventDefault();
        e.returnValue = 'Download in progress. Closing the tab will interrupt and potentially corrupt the download. Are you sure?';
        return e.returnValue;
    }
});

// 5. Initial Resume Check
(async () => {
    const existing = await stateStore.getAll();
    if (existing.length > 0) {
        dashboard.style.display = 'block';
        manager.reportProgress(); // Triggers onProgress to sync the bar immediately
        
        const pending = existing.filter(f => f.status !== 'transferred');
        if (pending.length > 0) {
            updateStatus(`Previous session found: ${pending.length} files are ready to be saved. Click "Start" to pick a folder or "Finalize ZIP".`, 'info');
            currentRequests = existing.map(f => ({
                id: f.id,
                url: f.url,
                fileName: f.fileName,
                totalSize: f.totalSize
            }));
        } else {
            updateStatus('All files from previous session were saved successfully!', 'success');
        }
    }
})();

fetchApiButton.addEventListener('click', async () => {
    const url = apiUrlInput.value.trim();
    if (!url) return;
    try {
        updateStatus(`Fetching URLs...`);
        const response = await fetch(url);
        const data = await response.json();
        await runDownloadFlow(data.presignedUrls);
    } catch (err: any) {
        updateStatus(`API Fetch Failed: ${err.message}`, 'error');
    }
});

startManualButton.addEventListener('click', async () => {
    const urls = manualInput.value.split(',').map(u => u.trim()).filter(u => u.length > 0);
    if (urls.length > 0) await runDownloadFlow(urls);
});
