import * as vscode from 'vscode';
import { BatchProcessor, BatchJob } from '../services/batchProcessor';

export class BatchManagerView {
    private static readonly viewType = 'git4neo.batchManager';
    private panel: vscode.WebviewPanel | undefined;

    constructor(private batchProcessor: BatchProcessor) {}

    show(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            BatchManagerView.viewType,
            'Git4Neo Batch Manager',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getWebviewContent();
        this.panel.webview.onDidReceiveMessage(this.handleMessage.bind(this));
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    private getWebviewContent(): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Git4Neo Batch Manager</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        padding: 20px;
                        background: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                    }
                    .container {
                        max-width: 1200px;
                        margin: 0 auto;
                    }
                    .section {
                        margin-bottom: 30px;
                        padding: 20px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                    }
                    .input-group {
                        margin-bottom: 15px;
                    }
                    label {
                        display: block;
                        margin-bottom: 5px;
                        font-weight: 500;
                    }
                    input, textarea, select {
                        width: 100%;
                        padding: 8px;
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        font-family: inherit;
                    }
                    textarea {
                        height: 120px;
                        resize: vertical;
                    }
                    button {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 10px 20px;
                        border-radius: 4px;
                        cursor: pointer;
                        margin-right: 10px;
                        margin-bottom: 10px;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    button:disabled {
                        opacity: 0.6;
                        cursor: not-allowed;
                    }
                    .job-list {
                        margin-top: 20px;
                    }
                    .job-item {
                        padding: 15px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                        margin-bottom: 10px;
                        background: var(--vscode-editor-background);
                    }
                    .job-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 10px;
                    }
                    .job-name {
                        font-weight: 600;
                        font-size: 16px;
                    }
                    .job-status {
                        padding: 4px 8px;
                        border-radius: 12px;
                        font-size: 12px;
                        font-weight: 500;
                    }
                    .status-pending { background: #ffd700; color: #000; }
                    .status-running { background: #007acc; color: #fff; }
                    .status-completed { background: #28a745; color: #fff; }
                    .status-failed { background: #dc3545; color: #fff; }
                    .progress-bar {
                        width: 100%;
                        height: 8px;
                        background: var(--vscode-progressBar-background);
                        border-radius: 4px;
                        overflow: hidden;
                        margin: 10px 0;
                    }
                    .progress-fill {
                        height: 100%;
                        background: var(--vscode-progressBar-foreground);
                        transition: width 0.3s ease;
                    }
                    .job-details {
                        font-size: 14px;
                        color: var(--vscode-descriptionForeground);
                    }
                    .error-list {
                        margin-top: 10px;
                        padding: 10px;
                        background: var(--vscode-inputValidation-errorBackground);
                        border: 1px solid var(--vscode-inputValidation-errorBorder);
                        border-radius: 4px;
                        color: var(--vscode-inputValidation-errorForeground);
                    }
                    .file-input {
                        display: none;
                    }
                    .file-label {
                        display: inline-block;
                        padding: 10px 20px;
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        border-radius: 4px;
                        cursor: pointer;
                        margin-bottom: 10px;
                    }
                    .file-label:hover {
                        background: var(--vscode-button-secondaryHoverBackground);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Git4Neo Batch Manager</h1>
                    
                    <div class="section">
                        <h2>Create New Batch Job</h2>
                        <div class="input-group">
                            <label for="jobName">Job Name:</label>
                            <input type="text" id="jobName" placeholder="Enter a name for this batch job">
                        </div>
                        
                        <div class="input-group">
                            <label for="repoList">Repository URLs (one per line):</label>
                            <textarea id="repoList" placeholder="https://github.com/username/repo1&#10;https://github.com/username/repo2&#10;https://github.com/username/repo3"></textarea>
                        </div>
                        
                        <div class="input-group">
                            <label class="file-label" for="fileInput">Or load from file</label>
                            <input type="file" id="fileInput" class="file-input" accept=".txt,.json">
                        </div>
                        
                        <button onclick="createJob()">Create Batch Job</button>
                        <button onclick="clearForm()">Clear Form</button>
                    </div>
                    
                    <div class="section">
                        <h2>Batch Jobs</h2>
                        <div id="jobList" class="job-list">
                            <p>No batch jobs created yet.</p>
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    const ghUrlRe = /^https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/?$/;

                    function createJob() {
                        const name = document.getElementById('jobName').value.trim();
                        const repos = document.getElementById('repoList').value
                            .split('\\n')
                            .map(url => url.trim())
                            .filter(url => url.length > 0);
                        
                        if (!name) {
                            alert('Please enter a job name');
                            return;
                        }
                        if (repos.length === 0) {
                            alert('Please enter at least one repository URL');
                            return;
                        }
                        const invalid = repos.filter(u => !ghUrlRe.test(u));
                        if (invalid.length > 0) {
                            alert('Invalid GitHub URLs:\\n' + invalid.join('\\n'));
                            return;
                        }
                        
                        vscode.postMessage({
                            command: 'createJob',
                            name: name,
                            repositories: repos
                        });
                    }
                    
                    function clearForm() {
                        document.getElementById('jobName').value = '';
                        document.getElementById('repoList').value = '';
                    }
                    
                    function startJob(jobId) {
                        vscode.postMessage({
                            command: 'startJob',
                            jobId: jobId
                        });
                    }
                    
                    function resumeJob(jobId) {
                        vscode.postMessage({
                            command: 'resumeJob',
                            jobId: jobId
                        });
                    }
                    
                    function pauseJob(jobId) {
                        vscode.postMessage({
                            command: 'pauseJob',
                            jobId: jobId
                        });
                    }
                    
                    function deleteJob(jobId) {
                        if (confirm('Are you sure you want to delete this job?')) {
                            vscode.postMessage({
                                command: 'deleteJob',
                                jobId: jobId
                            });
                        }
                    }
                    
                    function exportJob(jobId) {
                        vscode.postMessage({
                            command: 'exportJob',
                            jobId: jobId
                        });
                    }
                    
                    function saveJob(jobId) {
                        vscode.postMessage({
                            command: 'saveJob',
                            jobId: jobId
                        });
                    }
                    
                    function loadJob() {
                        vscode.postMessage({
                            command: 'loadJob'
                        });
                    }
                    
                    function updateJobList(jobs) {
                        const jobList = document.getElementById('jobList');
                        
                        if (jobs.length === 0) {
                            jobList.innerHTML = '<p>No batch jobs created yet.</p>';
                            return;
                        }
                        
                        jobList.innerHTML = jobs.map(job => \`
                            <div class="job-item">
                                <div class="job-header">
                                    <span class="job-name">\${job.name}</span>
                                    <span class="job-status status-\${job.status}">\${job.status}</span>
                                </div>
                                
                                <div class="progress-bar">
                                    <div class="progress-fill" style="width: \${job.progress}%"></div>
                                </div>
                                
                                <div class="job-details">
                                    <p>Repositories: \${job.results.processedRepos}/\${job.results.totalRepos}</p>
                                    <p>Success: \${job.results.successRepos} | Failed: \${job.results.failedRepos}</p>
                                    \${job.results.totalFiles > 0 ? \`<p>Files: \${job.results.processedFiles}/\${job.results.totalFiles} | Skipped: \${job.results.skippedFiles}</p>\` : ''}
                                    \${job.startTime ? \`<p>Started: \${new Date(job.startTime).toLocaleString()}</p>\` : ''}
                                    \${job.endTime ? \`<p>Completed: \${new Date(job.endTime).toLocaleString()}</p>\` : ''}
                                    <p>Config: Batch Size: \${job.config.batchSize}, Max Concurrent: \${job.config.maxConcurrentRepos}, Streaming: \${job.config.enableStreaming ? 'Yes' : 'No'}</p>
                                </div>
                                
                                \${job.errors.length > 0 ? \`
                                    <div class="error-list">
                                        <strong>Errors:</strong>
                                        <ul>\${job.errors.map(error => \`<li>\${error}</li>\`).join('')}</ul>
                                    </div>
                                \` : ''}
                                
                                <div style="margin-top: 15px;">
                                    \${job.status === 'pending' ? \`<button onclick="startJob('\${job.id}')">Start Job</button>\` : ''}
                                    \${job.status === 'running' ? \`<button onclick="pauseJob('\${job.id}')">Pause</button>\` : ''}
                                    \${job.status === 'paused' ? \`<button onclick="resumeJob('\${job.id}')">Resume</button>\` : ''}
                                    <button onclick="deleteJob('\${job.id}')">Delete</button>
                                    <button onclick="exportJob('\${job.id}')">Export Results</button>
                                    <button onclick="saveJob('\${job.id}')">Save Job</button>
                                </div>
                            </div>
                        \`).join('');
                    }
                    
            
                    document.getElementById('fileInput').addEventListener('change', function(e) {
                        const file = e.target.files[0];
                        if (file) {
                            const reader = new FileReader();
                            reader.onload = function(e) {
                                const content = e.target.result;
                                if (file.name.endsWith('.json')) {
                                    try {
                                        const data = JSON.parse(content);
                                        document.getElementById('jobName').value = data.name || '';
                                        document.getElementById('repoList').value = data.repositories.join('\\n');
                                    } catch (error) {
                                        alert('Invalid JSON file');
                                    }
                                } else {
                                    document.getElementById('repoList').value = content;
                                }
                            };
                            reader.readAsText(file);
                        }
                    });
                    
            
                    let pollTimer = null;

                    function startPolling() {
                        if (pollTimer) return;
                        pollTimer = setInterval(() => {
                            vscode.postMessage({ command: 'getJobs' });
                        }, 2000);
                    }

                    function stopPolling() {
                        if (pollTimer) {
                            clearInterval(pollTimer);
                            pollTimer = null;
                        }
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.command) {
                            case 'updateJobs':
                                updateJobList(message.jobs);
                                const hasRunning = message.jobs.some(j => j.status === 'running');
                                if (hasRunning) { startPolling(); }
                                else { stopPolling(); }
                                break;
                        }
                    });
                    
                    vscode.postMessage({ command: 'getJobs' });
                </script>
            </body>
            </html>
        `;
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.command) {
            case 'createJob':
                await this.createJob(message.name, message.repositories);
                break;
            case 'startJob':
                await this.startJob(message.jobId);
                break;
            case 'deleteJob':
                this.batchProcessor.deleteJob(message.jobId);
                this.updateJobList();
                break;
            case 'exportJob':
                await this.exportJob(message.jobId);
                break;
            case 'saveJob':
                await this.saveJob(message.jobId);
                break;
            case 'loadJob':
                await this.loadJob();
                break;
            case 'pauseJob':
                this.batchProcessor.pauseJob(message.jobId);
                this.updateJobList();
                break;
            case 'resumeJob':
                this.batchProcessor.resumeJob(message.jobId);
                this.updateJobList();
                break;
            case 'getJobs':
                this.updateJobList();
                break;
        }
    }

    private async createJob(name: string, repositories: string[]): Promise<void> {
        const config = {
            batchSize: 3,
            maxConcurrentRepos: 2,
            maxFileSize: 1024 * 1024, // 1MB
            enableStreaming: true,
            memoryThreshold: 0.8
        };
        
        const jobId = await this.batchProcessor.createBatchJob(name, repositories, config);
        this.updateJobList();
        vscode.window.showInformationMessage(`Batch job "${name}" created with ${repositories.length} repositories`);
    }

    private async startJob(jobId: string): Promise<void> {
        const job = this.batchProcessor.getJob(jobId);
        if (!job) {
            vscode.window.showErrorMessage('Job not found');
            return;
        }

        this.updateJobList();

        const pollId = setInterval(() => this.updateJobList(), 2000);

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Processing batch job: ${job.name}`,
                cancellable: false
            }, async (progress) => {
                await this.batchProcessor.processBatch(jobId, progress);
            });
            vscode.window.showInformationMessage(`Batch job "${job.name}" finished`);
        } catch (error) {
            vscode.window.showErrorMessage(`Batch job failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            clearInterval(pollId);
            this.updateJobList();
        }
    }

    private async exportJob(jobId: string): Promise<void> {
        try {
            const results = await this.batchProcessor.exportJobResults(jobId);
            const uri = await vscode.window.showSaveDialog({
                filters: { 'JSON': ['json'] }
            });

            if (uri) {
                const fs = require('fs');
                await fs.promises.writeFile(uri.fsPath, JSON.stringify(results, null, 2));
                vscode.window.showInformationMessage('Job results exported');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to export job: ${error}`);
        }
    }

    private async saveJob(jobId: string): Promise<void> {
        try {
            const uri = await vscode.window.showSaveDialog({
                filters: { 'JSON': ['json'] }
            });

            if (uri) {
                await this.batchProcessor.saveJobToFile(jobId, uri.fsPath);
                vscode.window.showInformationMessage('Job saved');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save job: ${error}`);
        }
    }

    private async loadJob(): Promise<void> {
        try {
            const uris = await vscode.window.showOpenDialog({
                filters: { 'JSON': ['json'] },
                canSelectMany: false
            });

            if (uris && uris.length > 0) {
                const jobId = await this.batchProcessor.loadJobFromFile(uris[0].fsPath);
                this.updateJobList();
                vscode.window.showInformationMessage('Job loaded');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load job: ${error}`);
        }
    }

    private updateJobList(): void {
        if (this.panel) {
            const jobs = this.batchProcessor.getAllJobs();
            this.panel.webview.postMessage({
                command: 'updateJobs',
                jobs: jobs
            });
        }
    }
}
