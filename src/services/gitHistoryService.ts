import * as vscode from 'vscode';
import simpleGit, { SimpleGit } from 'simple-git';

export interface CommitInfo {
    hash: string;
    message: string;
    author: string;
    date: Date;
}

export class GitHistoryService {
    private git: SimpleGit | null = null;

    async getCommitHistory(limit?: number): Promise<CommitInfo[]> {
        if (!this.git) throw new Error('Git not initialized');

        const log = await this.git.log({ maxCount: limit || 100 });
        const commits: CommitInfo[] = [];

        for (const commit of log.all) {
            commits.push({
                hash: commit.hash,
                message: commit.message,
                author: commit.author_name,
                date: new Date(commit.date)
            });
        }

        return commits;
    }
