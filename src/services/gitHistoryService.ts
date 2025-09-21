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

    async initialize(repoPath: string): Promise<void> {
        this.git = simpleGit(repoPath);
    }
}
