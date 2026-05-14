import * as vscode from 'vscode';
import { Neo4jService } from './neo4jService';
import { GitHubService } from './githubService';
import { RepositoryAnalyzer } from './repositoryAnalyzer';

export interface BatchJob {
    id: string;
    name: string;
    repositories: string[];
    status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
    progress: number;
    startTime?: Date;
    endTime?: Date;
    errors: string[];
    results: {
        totalRepos: number;
        processedRepos: number;
        failedRepos: number;
        successRepos: number;
        totalFiles: number;
        processedFiles: number;
        skippedFiles: number;
    };
    config: {
        batchSize: number;
        maxConcurrentRepos: number;
        maxFileSize: number;
        enableStreaming: boolean;
        memoryThreshold: number;
    };
}

export class BatchProcessor {
    private jobs: Map<string, BatchJob> = new Map();
    private isProcessing = false;

    constructor(
        private neo4jService: Neo4jService,
        private githubService: GitHubService,
        private repositoryAnalyzer: RepositoryAnalyzer
    ) {}

    async createBatchJob(name: string, repositories: string[], config?: Partial<BatchJob['config']>): Promise<string> {
        const jobId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const job: BatchJob = {
            id: jobId,
            name,
            repositories,
            status: 'pending',
            progress: 0,
            errors: [],
            results: {
                totalRepos: repositories.length,
                processedRepos: 0,
                failedRepos: 0,
                successRepos: 0,
                totalFiles: 0,
                processedFiles: 0,
                skippedFiles: 0
            },
            config: {
                batchSize: config?.batchSize || 3,
                maxConcurrentRepos: config?.maxConcurrentRepos || 2,
                maxFileSize: config?.maxFileSize || 1024 * 1024, // 1MB
                enableStreaming: config?.enableStreaming ?? true,
                memoryThreshold: config?.memoryThreshold || 0.8 // 80% memory usage
            }
        };

        this.jobs.set(jobId, job);
        return jobId;
    }

    async processBatch(jobId: string, progress?: vscode.Progress<{ increment?: number; message?: string }>): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new Error('Job not found');
        }

        if (this.isProcessing) {
            throw new Error('Another batch is already processing');
        }

        this.isProcessing = true;
        job.status = 'running';
        job.startTime = new Date();

        let connectionEstablished = false;
        try {
            await this.neo4jService.connect();
            connectionEstablished = true;

            const batchSize = job.config.batchSize;
            const totalBatches = Math.ceil(job.repositories.length / batchSize);

            for (let i = 0; i < totalBatches; i++) {
                const currentJob = this.jobs.get(jobId);
                if (!currentJob) break;
                
                if (currentJob.status === 'paused') {
                    await this.waitForResume(jobId);
                }

                if (currentJob.status === 'failed') {
                    break;
                }

                const start = i * batchSize;
                const end = Math.min(start + batchSize, currentJob.repositories.length);
                const batch = currentJob.repositories.slice(start, end);

                const batchProgress = ((i + 1) / totalBatches) * 100;
                currentJob.progress = Math.min(batchProgress, 100);
                
                progress?.report({
                    increment: (100 / totalBatches),
                    message: `Processing batch ${i + 1}/${totalBatches} (${batch.length} repositories)`
                });

                await this.processBatchConcurrently(batch, currentJob, progress);
                
                // Check memory usage and pause if needed
                if (this.isMemoryUsageHigh(currentJob.config.memoryThreshold)) {
                    progress?.report({ message: 'High memory usage detected, pausing briefly...' });
                    await this.pauseForMemoryCleanup();
                }
            }

            const finalJob = this.jobs.get(jobId);
            if (finalJob && finalJob.status === 'running') {
                finalJob.status = 'completed';
                finalJob.progress = 100;
                finalJob.endTime = new Date();
            }

        } catch (error) {
            const errorJob = this.jobs.get(jobId);
            if (errorJob) {
                errorJob.status = 'failed';
                errorJob.errors.push(error instanceof Error ? error.message : String(error));
            }
            throw error;
        } finally {
            this.isProcessing = false;
            if (connectionEstablished) {
                await this.neo4jService.disconnect();
            }
        }
    }

    private async processBatchConcurrently(
        repositories: string[], 
        job: BatchJob, 
        progress?: vscode.Progress<{ increment?: number; message?: string }>
    ): Promise<void> {
        const semaphore = new Semaphore(job.config.maxConcurrentRepos);
        
        const promises = repositories.map(async (repoUrl) => {
            return semaphore.acquire(async () => {
                try {
                    progress?.report({ message: `Analyzing ${repoUrl}...` });
                    
                    const analysisConfig = {
                        maxFileSize: job.config.maxFileSize,
                        enableStreaming: job.config.enableStreaming,
                        batchSize: job.config.batchSize
                    };
                    
                    const analysis = await this.repositoryAnalyzer.analyzeRepository(repoUrl, analysisConfig, progress, true);
                    
                    job.results.successRepos++;
                    job.results.processedRepos++;
                    job.results.totalFiles += analysis.totalFiles;
                    job.results.processedFiles += analysis.processedFiles;
                    job.results.skippedFiles += analysis.skippedFiles;
                    
                    progress?.report({ message: `Finished ${repoUrl}` });
                    
                } catch (error) {
                    job.results.failedRepos++;
                    job.results.processedRepos++;
                    job.errors.push(`${repoUrl}: ${error instanceof Error ? error.message : String(error)}`);
                    
                    progress?.report({ message: `Failed ${repoUrl}: ${error instanceof Error ? error.message : String(error)}` });
                }
            });
        });

        await Promise.allSettled(promises);
    }

    getJob(jobId: string): BatchJob | undefined {
        return this.jobs.get(jobId);
    }

    getAllJobs(): BatchJob[] {
        return Array.from(this.jobs.values());
    }

    deleteJob(jobId: string): boolean {
        return this.jobs.delete(jobId);
    }

    async saveJobToFile(jobId: string, filePath: string): Promise<void> {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new Error('Job not found');
        }

        const fs = require('fs');
        await fs.promises.writeFile(filePath, JSON.stringify(job, null, 2));
    }

    async loadJobFromFile(filePath: string): Promise<string> {
        const fs = require('fs');
        const jobData = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        
        const job: BatchJob = {
            ...jobData,
            id: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            status: 'pending',
            progress: 0,
            startTime: undefined,
            endTime: undefined
        };

        this.jobs.set(job.id, job);
        return job.id;
    }

    async exportJobResults(jobId: string): Promise<any> {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new Error('Job not found');
        }

        return {
            jobId: job.id,
            name: job.name,
            summary: {
                totalRepositories: job.results.totalRepos,
                successfulRepositories: job.results.successRepos,
                failedRepositories: job.results.failedRepos,
                totalFiles: job.results.totalFiles,
                processedFiles: job.results.processedFiles,
                skippedFiles: job.results.skippedFiles,
                processingTime: job.startTime && job.endTime 
                    ? job.endTime.getTime() - job.startTime.getTime() 
                    : 0
            },
            errors: job.errors,
            repositories: job.repositories,
            config: job.config
        };
    }

    pauseJob(jobId: string): void {
        const job = this.jobs.get(jobId);
        if (job && job.status === 'running') {
            job.status = 'paused';
        }
    }

    resumeJob(jobId: string): void {
        const job = this.jobs.get(jobId);
        if (job && job.status === 'paused') {
            job.status = 'running';
        }
    }

    private async waitForResume(jobId: string): Promise<void> {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const job = this.jobs.get(jobId);
                if (!job || job.status !== 'paused') {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 1000);
        });
    }

    private isMemoryUsageHigh(threshold: number = 0.8): boolean {
        const used = process.memoryUsage();
        const total = used.heapTotal;
        const usage = used.heapUsed / total;
        return usage > threshold;
    }

    private async pauseForMemoryCleanup(): Promise<void> {
        if (global.gc) {
            global.gc();
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

class Semaphore {
    private permits: number;
    private waitingQueue: Array<() => void> = [];

    constructor(permits: number) {
        this.permits = permits;
    }

    async acquire<T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const executeTask = async () => {
                try {
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    this.release();
                }
            };

            if (this.permits > 0) {
                this.permits--;
                executeTask();
            } else {
                this.waitingQueue.push(executeTask);
            }
        });
    }

    private release(): void {
        if (this.waitingQueue.length > 0) {
            const nextTask = this.waitingQueue.shift();
            if (nextTask) {
                nextTask();
            }
        } else {
            this.permits++;
        }
    }
}
