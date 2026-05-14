import * as vscode from 'vscode';
import simpleGit, { SimpleGit } from 'simple-git';

export interface CommitInfo {
    hash: string;
    message: string;
    author: string;
    email: string;
    date: Date;
    insertions: number;
    deletions: number;
    filesChanged: number;
    type: string;
    priority: string;
    effort: string;
}

export interface AuthorInfo {
    name: string;
    email: string;
    team?: string;
    role?: string;
    timezone?: string;
    joinDate?: Date;
}

export interface WorkPattern {
    timeOfDay: string;
    dayOfWeek: string;
    duration: string;
    focus: string;
    motivation: string;
}

export class GitHistoryService {
    private git: SimpleGit | null = null;

    async initialize(repoPath: string): Promise<void> {
        this.git = simpleGit(repoPath);
    }

    async getCommitHistory(limit?: number): Promise<CommitInfo[]> {
        if (!this.git) throw new Error('Git not initialized');

        const log = await this.git.log({ maxCount: limit || 100 });
        const commits: CommitInfo[] = [];

        for (const commit of log.all) {
            const stats = await this.git.show([commit.hash, '--stat']);
            const insertions = this.extractInsertions(stats);
            const deletions = this.extractDeletions(stats);
            const filesChanged = this.extractFilesChanged(stats);
            
            commits.push({
                hash: commit.hash,
                message: commit.message,
                author: commit.author_name,
                email: commit.author_email,
                date: new Date(commit.date),
                insertions,
                deletions,
                filesChanged,
                type: this.classifyCommitType(commit.message),
                priority: this.classifyPriority(commit.message),
                effort: this.classifyEffort(insertions, deletions, filesChanged)
            });
        }

        return commits;
    }

    async getAuthorInfo(email: string): Promise<AuthorInfo> {
        if (!this.git) throw new Error('Git not initialized');

        const log = await this.git.log({ 
            author: email,
            maxCount: 1
        });

        if (log.all.length === 0) {
            return {
                name: email.split('@')[0],
                email: email
            };
        }

        const firstCommit = log.all[0];
        return {
            name: firstCommit.author_name,
            email: firstCommit.author_email,
            team: this.inferTeamFromEmail(email),
            role: this.inferRoleFromCommits([...log.all]),
            timezone: this.inferTimezoneFromCommits([...log.all]),
            joinDate: new Date(firstCommit.date)
        };
    }

    async getWorkPatterns(email: string, limit?: number): Promise<WorkPattern[]> {
        if (!this.git) throw new Error('Git not initialized');

        const log = await this.git.log({ 
            author: email,
            maxCount: limit || 50
        });

        const patterns: WorkPattern[] = [];

        for (const commit of log.all) {
            const date = new Date(commit.date);
            const timeOfDay = this.getTimeOfDay(date);
            const dayOfWeek = this.getDayOfWeek(date);
            const duration = this.calculateCommitDuration(commit);
            const focus = this.classifyFocus(commit.message);
            const motivation = this.classifyMotivation(commit.message);

            patterns.push({
                timeOfDay,
                dayOfWeek,
                duration,
                focus,
                motivation
            });
        }

        return patterns;
    }

    async getCollaborationData(): Promise<Map<string, string[]>> {
        if (!this.git) throw new Error('Git not initialized');

        const log = await this.git.log({ maxCount: 1000 });
        const collaborations = new Map<string, string[]>();

        for (const commit of log.all) {
            const coAuthors = this.extractCoAuthors(commit.message);
            if (coAuthors.length > 0) {
                const mainAuthor = commit.author_email;
                if (!collaborations.has(mainAuthor)) {
                    collaborations.set(mainAuthor, []);
                }
                collaborations.get(mainAuthor)!.push(...coAuthors);
            }
        }

        return collaborations;
    }

    async getCommitFiles(commitHash: string): Promise<string[]> {
        if (!this.git) throw new Error('Git not initialized');
        const output = await this.git.show([commitHash, '--name-only', '--pretty=format:']);
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
    }

    private extractInsertions(stats: string): number {
        const match = stats.match(/(\d+) insertions?/);
        return match ? parseInt(match[1]) : 0;
    }

    private extractDeletions(stats: string): number {
        const match = stats.match(/(\d+) deletions?/);
        return match ? parseInt(match[1]) : 0;
    }

    private extractFilesChanged(stats: string): number {
        const match = stats.match(/(\d+) files? changed/);
        return match ? parseInt(match[1]) : 0;
    }

    private classifyCommitType(message: string): string {
        const msg = message.toLowerCase();
        if (msg.includes('fix') || msg.includes('bug')) return 'bugfix';
        if (msg.includes('feat') || msg.includes('feature')) return 'feature';
        if (msg.includes('refactor')) return 'refactor';
        if (msg.includes('docs') || msg.includes('readme')) return 'docs';
        if (msg.includes('test')) return 'test';
        return 'other';
    }

    private classifyPriority(message: string): string {
        const msg = message.toLowerCase();
        if (msg.includes('urgent') || msg.includes('critical') || msg.includes('hotfix')) return 'high';
        if (msg.includes('important') || msg.includes('priority')) return 'medium';
        return 'low';
    }

    private classifyEffort(insertions: number, deletions: number, filesChanged: number): string {
        const totalChanges = insertions + deletions;
        if (totalChanges > 500 || filesChanged > 20) return 'high';
        if (totalChanges > 100 || filesChanged > 5) return 'medium';
        return 'low';
    }

    private inferTeamFromEmail(email: string): string {
        const domain = email.split('@')[1];
        if (domain.includes('frontend') || domain.includes('ui')) return 'Frontend';
        if (domain.includes('backend') || domain.includes('api')) return 'Backend';
        if (domain.includes('devops') || domain.includes('infra')) return 'DevOps';
        if (domain.includes('qa') || domain.includes('test')) return 'QA';
        return 'Unknown';
    }

    private inferRoleFromCommits(commits: any[]): string {
        const messageCount = commits.length;
        const avgMessageLength = commits.reduce((sum, c) => sum + c.message.length, 0) / messageCount;
        
        if (messageCount > 100 && avgMessageLength > 50) return 'Senior Developer';
        if (messageCount > 50) return 'Developer';
        if (messageCount > 20) return 'Junior Developer';
        return 'Contributor';
    }

    private inferTimezoneFromCommits(commits: any[]): string {
        const hours = commits.map(c => new Date(c.date).getHours());
        const avgHour = hours.reduce((sum, h) => sum + h, 0) / hours.length;
        
        if (avgHour >= 6 && avgHour < 12) return 'Morning Person';
        if (avgHour >= 12 && avgHour < 18) return 'Afternoon Person';
        if (avgHour >= 18 && avgHour < 22) return 'Evening Person';
        return 'Night Owl';
    }

    private getTimeOfDay(date: Date): string {
        const hour = date.getHours();
        if (hour >= 6 && hour < 12) return 'morning';
        if (hour >= 12 && hour < 18) return 'afternoon';
        if (hour >= 18 && hour < 22) return 'evening';
        return 'night';
    }

    private getDayOfWeek(date: Date): string {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return days[date.getDay()];
    }

    private calculateCommitDuration(commit: any): string {
        const messageLength = commit.message.length;
        if (messageLength > 200) return 'long session';
        if (messageLength > 100) return 'medium session';
        return 'quick fix';
    }

    private classifyFocus(message: string): string {
        const msg = message.toLowerCase();
        if (msg.includes('refactor') || msg.includes('architecture')) return 'deep work';
        if (msg.includes('review') || msg.includes('feedback')) return 'review';
        if (msg.includes('meeting') || msg.includes('sync')) return 'meetings';
        return 'development';
    }

    private classifyMotivation(message: string): string {
        const msg = message.toLowerCase();
        if (msg.includes('deadline') || msg.includes('urgent')) return 'deadline pressure';
        if (msg.includes('request') || msg.includes('feature')) return 'feature request';
        if (msg.includes('bug') || msg.includes('issue')) return 'bug report';
        if (msg.includes('improve') || msg.includes('optimize')) return 'improvement';
        return 'routine work';
    }

    private extractCoAuthors(message: string): string[] {
        const coAuthorMatches = message.match(/Co-authored-by:\s*([^<\n]+)\s*<([^>]+)>/gi);
        if (!coAuthorMatches) return [];
        
        return coAuthorMatches.map(match => {
            const emailMatch = match.match(/<([^>]+)>/);
            return emailMatch ? emailMatch[1] : '';
        }).filter(email => email);
    }
}
