import * as vscode from 'vscode';
import { Neo4jService } from './neo4jService';
import { GitHubService } from './githubService';
import { RepositoryAnalyzer } from './repositoryAnalyzer';

export interface BatchJob {
    id: string;
    name: string;
    repositories: string[];
    status: 'pending' | 'running' | 'completed' | 'failed';
    progress: number;
    startTime?: Date;
    endTime?: Date;
    errors: string[];
    results: {
        totalRepos: number;
        processedRepos: number;
        failedRepos: number;
        successRepos: number;
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

    async createBatchJob(name: string, repositories: string[]): Promise<string> {
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
                successRepos: 0
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

        try {
            await this.neo4jService.connect();

            const batchSize = 5;
            const totalBatches = Math.ceil(job.repositories.length / batchSize);

            for (let i = 0; i < totalBatches; i++) {
                const start = i * batchSize;
                const end = Math.min(start + batchSize, job.repositories.length);
                const batch = job.repositories.slice(start, end);

                progress?.report({
                    increment: (100 / totalBatches),
                    message: `Processing batch ${i + 1}/${totalBatches} (${batch.length} repositories)`
                });

                await this.processBatchConcurrently(batch, job, progress);
            }

            job.status = 'completed';
            job.progress = 100;
            job.endTime = new Date();

        } catch (error) {
            job.status = 'failed';
            job.errors.push(error instanceof Error ? error.message : String(error));
            throw error;
        } finally {
            this.isProcessing = false;
            await this.neo4jService.disconnect();
        }
    }

    private async processBatchConcurrently(
        repositories: string[], 
        job: BatchJob, 
        progress?: vscode.Progress<{ increment?: number; message?: string }>
    ): Promise<void> {
        const promises = repositories.map(async (repoUrl) => {
            try {
                progress?.report({ message: `Analyzing ${repoUrl}...` });
                
                await this.repositoryAnalyzer.analyzeRepository(repoUrl);
                
                job.results.successRepos++;
                job.results.processedRepos++;
                
                progress?.report({ message: `Finished ${repoUrl}` });
                
            } catch (error) {
                job.results.failedRepos++;
                job.results.processedRepos++;
                job.errors.push(`${repoUrl}: ${error instanceof Error ? error.message : String(error)}`);
                
                progress?.report({ message: `Failed ${repoUrl}: ${error instanceof Error ? error.message : String(error)}` });
            }
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
                processingTime: job.startTime && job.endTime 
                    ? job.endTime.getTime() - job.startTime.getTime() 
                    : 0
            },
            errors: job.errors,
            repositories: job.repositories
        };
    }
}
