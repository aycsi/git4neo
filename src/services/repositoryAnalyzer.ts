import * as vscode from 'vscode';
import { Neo4jService } from './neo4jService';
import { GitHubService, RepositoryInfo, FileInfo, FunctionInfo, ClassInfo, StreamingConfig } from './githubService';
import { GitHistoryService } from './gitHistoryService';
import { DependencyAnalyzer } from './dependencyAnalyzer';
import { ComplexityAnalyzer } from './complexityAnalyzer';

export interface AnalysisConfig {
    maxFileSize: number;
    enableStreaming: boolean;
    chunkSize: number;
    skipLargeFiles: boolean;
    batchSize: number;
}

export interface AnalysisSummary {
    totalFiles: number;
    processedFiles: number;
    skippedFiles: number;
    commitCount: number;
    contributorCount: number;
}

export class RepositoryAnalyzer {
    constructor(
        private neo4jService: Neo4jService,
        private githubService: GitHubService
    ) {}

    private gitHistoryService = new GitHistoryService();
    private dependencyAnalyzer = new DependencyAnalyzer();
    private complexityAnalyzer = new ComplexityAnalyzer();

    async analyzeRepository(repoUrl: string, config?: Partial<AnalysisConfig>, progress?: vscode.Progress<{ increment?: number; message?: string }>, skipConnectionManagement: boolean = false): Promise<AnalysisSummary> {
        const analysisConfig: AnalysisConfig = {
            maxFileSize: config?.maxFileSize || 1024 * 1024, // 1MB
            enableStreaming: config?.enableStreaming ?? true,
            chunkSize: config?.chunkSize || 8192,
            skipLargeFiles: config?.skipLargeFiles ?? true,
            batchSize: config?.batchSize || 10
        };

        const streamingConfig: StreamingConfig = {
            maxFileSize: analysisConfig.maxFileSize,
            enableStreaming: analysisConfig.enableStreaming,
            chunkSize: analysisConfig.chunkSize
        };

        let repoPath: string | null = null;
        let fileSummary: Pick<AnalysisSummary, 'totalFiles' | 'processedFiles' | 'skippedFiles'> = {
            totalFiles: 0,
            processedFiles: 0,
            skippedFiles: 0
        };
        let gitSummary: Pick<AnalysisSummary, 'commitCount' | 'contributorCount'> = {
            commitCount: 0,
            contributorCount: 0
        };
        try {
            if (!skipConnectionManagement) {
                await this.neo4jService.connect();
            }

            progress?.report({ increment: 10, message: 'Fetching repository information...' });
            const repoInfo = await this.githubService.getRepositoryInfo(repoUrl);

            progress?.report({ increment: 20, message: 'Creating repository node...' });
            const repositoryId = await this.neo4jService.createRepositoryNode(repoInfo);

            progress?.report({ increment: 30, message: 'Cloning repository...' });
            repoPath = await this.githubService.cloneRepository(repoInfo.cloneUrl);

            progress?.report({ increment: 40, message: 'Analyzing files...' });
            
            if (analysisConfig.enableStreaming) {
                fileSummary = await this.analyzeRepositoryStreaming(repoPath!, repositoryId, streamingConfig, progress);
            } else {
                fileSummary = await this.analyzeRepositoryBatch(repoPath!, repositoryId, streamingConfig, progress);
            }

            progress?.report({ increment: 50, message: 'Analyzing git history...' });
            gitSummary = await this.analyzeGitHistory(repoPath!, repositoryId);

            progress?.report({ increment: 60, message: 'Analyzing dependencies...' });
            await this.analyzeDependencies(repoPath!, repositoryId);

            progress?.report({ increment: 70, message: 'Analyzing complexity...' });
            await this.analyzeComplexity(repoPath!, repositoryId);

            progress?.report({ increment: 90, message: 'Cleaning up...' });
            await this.githubService.cleanup();

            progress?.report({ increment: 100, message: 'Analysis finished' });
            return {
                ...fileSummary,
                ...gitSummary
            };

        } catch (error) {
            await this.githubService.cleanup();
            throw error;
        }
    }

    private async analyzeRepositoryStreaming(
        repoPath: string, 
        repositoryId: string, 
        config: StreamingConfig, 
        progress?: vscode.Progress<{ increment?: number; message?: string }>
    ): Promise<Pick<AnalysisSummary, 'totalFiles' | 'processedFiles' | 'skippedFiles'>> {
        let fileCount = 0;
        let processedFiles = 0;
        let skippedFiles = 0;

        progress?.report({ increment: 10, message: 'Streaming files...' });

        for await (const file of this.githubService.streamFiles(repoPath, config)) {
            fileCount++;
            
            try {
                // Create file node
                await this.neo4jService.createFileNode({
                    path: file.path,
                    name: file.name,
                    extension: file.extension,
                    size: file.size,
                    repositoryId
                });

                // Process file content if available
                if (file.content) {
                    await this.processFileContent(file, repositoryId);
                } else if (file.size <= config.maxFileSize) {
                    // Load content for files that weren't loaded initially
                    const content = await this.githubService.readFileContent(file.path, repoPath);
                    await this.processFileContent({ ...file, content }, repositoryId);
                } else {
                    skippedFiles++;
                    progress?.report({ message: `Skipped large file: ${file.path}` });
                }

                processedFiles++;
                
                if (processedFiles % 10 === 0) {
                    progress?.report({ message: `Processed ${processedFiles} files...` });
                }

            } catch (error) {
                progress?.report({ message: `Error processing ${file.path}: ${error}` });
            }
        }

        progress?.report({ 
            increment: 40, 
            message: `Completed streaming: ${processedFiles} files processed, ${skippedFiles} skipped` 
        });
        return {
            totalFiles: fileCount,
            processedFiles,
            skippedFiles
        };
    }

    private async analyzeRepositoryBatch(
        repoPath: string, 
        repositoryId: string, 
        config: StreamingConfig, 
        progress?: vscode.Progress<{ increment?: number; message?: string }>
    ): Promise<Pick<AnalysisSummary, 'totalFiles' | 'processedFiles' | 'skippedFiles'>> {
        progress?.report({ increment: 10, message: 'Loading all files...' });
        const files = await this.githubService.getAllFiles(repoPath, config);

        progress?.report({ increment: 20, message: 'Creating file nodes...' });
        await this.createFileNodes(files, repositoryId);

        progress?.report({ increment: 30, message: 'Extracting code elements...' });
        await this.extractCodeElements(files, repositoryId);

        progress?.report({ increment: 40, message: 'Creating relationships...' });
        await this.createRelationships(files, repositoryId);
        return {
            totalFiles: files.length,
            processedFiles: files.length,
            skippedFiles: 0
        };
    }

    private async processFileContent(file: FileInfo, repositoryId: string): Promise<void> {
        if (!file.content) return;

        const functions = this.githubService.extractFunctions(file.content, file.path);
        const classes = this.githubService.extractClasses(file.content, file.path);
        const hooks = this.githubService.extractHooks(file.content, file.path);
        const decorators = this.githubService.extractDecorators(file.content, file.path);

        // Create function nodes
        for (const func of functions) {
            await this.neo4jService.createFunctionNode({
                name: func.name,
                filePath: file.path,
                lineNumber: func.lineNumber,
                parameters: func.parameters,
                returnType: func.returnType,
                repositoryId
            });
        }

        // Create class nodes
        for (const cls of classes) {
            await this.neo4jService.createClassNode({
                name: cls.name,
                filePath: file.path,
                lineNumber: cls.lineNumber,
                methods: cls.methods,
                properties: cls.properties,
                repositoryId
            });
        }

        // Create hook nodes
        for (const hook of hooks) {
            await this.neo4jService.createHookNode({
                name: hook.name,
                filePath: file.path,
                lineNumber: hook.lineNumber,
                type: hook.type,
                dependencies: hook.dependencies,
                returnType: hook.returnType,
                repositoryId
            });
        }

        // Create decorator nodes
        for (const decorator of decorators) {
            await this.neo4jService.createDecoratorNode({
                name: decorator.name,
                filePath: file.path,
                lineNumber: decorator.lineNumber,
                target: decorator.target,
                arguments: decorator.arguments,
                repositoryId
            });
        }
    }

    private async createFileNodes(files: FileInfo[], repositoryId: string): Promise<void> {
        for (const file of files) {
            try {
                await this.neo4jService.createFileNode({
                    path: file.path,
                    name: file.name,
                    extension: file.extension,
                    size: file.size,
                    repositoryId
                });
            } catch (error) {
                vscode.window.showWarningMessage(`Failed to create node for ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async extractCodeElements(files: FileInfo[], repositoryId: string): Promise<void> {
        for (const file of files) {
            if (!file.content) { continue; }

            try {
                const functions = this.githubService.extractFunctions(file.content, file.path);
                const classes = this.githubService.extractClasses(file.content, file.path);

                for (const func of functions) {
                    await this.neo4jService.createFunctionNode({
                        name: func.name,
                        filePath: file.path,
                        lineNumber: func.lineNumber,
                        parameters: func.parameters,
                        returnType: func.returnType,
                        repositoryId
                    });
                }

                for (const cls of classes) {
                    await this.neo4jService.createClassNode({
                        name: cls.name,
                        filePath: file.path,
                        lineNumber: cls.lineNumber,
                        methods: cls.methods,
                        properties: cls.properties,
                        repositoryId
                    });
                }
            } catch (error) {
                vscode.window.showWarningMessage(`Failed to extract code from ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async createRelationships(files: FileInfo[], repositoryId: string): Promise<void> {
        const fileMap = new Map<string, FileInfo>();
        const functionMap = new Map<string, FunctionInfo>();
        const classMap = new Map<string, ClassInfo>();

        for (const file of files) {
            fileMap.set(file.path, file);
            
            if (!file.content) continue;
            
            const functions = this.githubService.extractFunctions(file.content, file.path);
            const classes = this.githubService.extractClasses(file.content, file.path);
            
            for (const func of functions) {
                functionMap.set(`${func.name}_${file.path}`, func);
            }
            
            for (const cls of classes) {
                classMap.set(`${cls.name}_${file.path}`, cls);
            }
        }

        for (const file of files) {
            if (!file.content) { continue; }

            try {
                const imports = this.githubService.extractImports(file.content);
                const functionCalls = this.githubService.extractFunctionCalls(file.content);

                for (const importPath of imports) {
                    const resolvedPath = this.resolveImportPath(importPath, file.path, fileMap);
                    if (resolvedPath) {
                        await this.neo4jService.createImportRelationship(file.path, resolvedPath, repositoryId);
                    }
                }

                for (const call of functionCalls) {
                    const targetFunction = this.findFunctionByName(call, functionMap);
                    if (targetFunction && file.content) {
                        const sourceFunctions = this.githubService.extractFunctions(file.content, file.path);
                        for (const sourceFunc of sourceFunctions) {
                            await this.neo4jService.createFunctionCallRelationship(
                                `${sourceFunc.name}_${file.path}`,
                                `${targetFunction.name}_${targetFunction.filePath}`,
                                repositoryId
                            );
                        }
                    }
                }
            } catch (error) {
                vscode.window.showWarningMessage(`Failed to create relationships for ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private resolveImportPath(importPath: string, sourceFilePath: string, fileMap: Map<string, FileInfo>): string | null {
        const possibleExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt'];
        
        for (const [filePath, file] of fileMap) {
            const fileName = file.name.replace(/\.[^/.]+$/, '');
            const importName = importPath.split('/').pop()?.replace(/\.[^/.]+$/, '');
            
            if (fileName === importName) {
                return filePath;
            }
            
            for (const ext of possibleExtensions) {
                if (filePath.endsWith(importPath + ext)) {
                    return filePath;
                }
            }
        }
        
        return null;
    }

    private findFunctionByName(functionName: string, functionMap: Map<string, FunctionInfo>): { name: string; filePath: string } | null {
        for (const [key, func] of functionMap) {
            if (func.name === functionName) {
                const filePath = key.split('_').slice(1).join('_');
                return { name: func.name, filePath };
            }
        }
        return null;
    }

    async analyzeCrossRepo(progress?: vscode.Progress<{ increment?: number; message?: string }>): Promise<{ deps: number; contribs: number; langs: number }> {
        await this.neo4jService.connect();

        progress?.report({ increment: 10, message: 'Linking shared dependencies...' });
        const deps = await this.neo4jService.linkSharedDeps();

        progress?.report({ increment: 40, message: 'Linking contributor overlap...' });
        const contribs = await this.neo4jService.linkContribOverlap();

        progress?.report({ increment: 70, message: 'Linking shared languages...' });
        const langs = await this.neo4jService.linkLangOverlap();

        progress?.report({ increment: 100, message: 'Cross-repo analysis complete' });
        return { deps, contribs, langs };
    }

    async getRepositoryStatistics(repositoryId: string): Promise<any> {
        await this.neo4jService.connect();
        const stats = await this.neo4jService.getRepositoryStats(repositoryId);
        return stats;
    }

    private async analyzeGitHistory(repoPath: string, repositoryId: string): Promise<Pick<AnalysisSummary, 'commitCount' | 'contributorCount'>> {
        await this.gitHistoryService.initialize(repoPath);
        const commits = await this.gitHistoryService.getCommitHistory(100);
        const repositoryFiles = new Set<string>((await this.githubService.getAllFiles(repoPath)).map(file => file.path));
        
        const uniqueAuthors = new Set<string>();
        const collaborations = await this.gitHistoryService.getCollaborationData();
        
        for (const commit of commits) {
            uniqueAuthors.add(commit.email);
            
            await this.neo4jService.createCommitNode({
                hash: commit.hash,
                message: commit.message,
                author: commit.author,
                email: commit.email,
                date: commit.date,
                insertions: commit.insertions,
                deletions: commit.deletions,
                effort: commit.effort,
                repositoryId
            });

            await this.neo4jService.createCommitAuthorRelationship(commit.hash, commit.email, repositoryId);

            const modifiedFiles = await this.gitHistoryService.getCommitFiles(commit.hash);
            for (const filePath of modifiedFiles) {
                if (repositoryFiles.has(filePath)) {
                    await this.neo4jService.createCommitFileRelationship(commit.hash, filePath, repositoryId);
                }
            }

            const patternId = this.toPatternId(commit.date);
            await this.neo4jService.createWorkPatternNode({
                timeOfDay: this.getTimeOfDay(commit.date),
                dayOfWeek: this.getDayOfWeek(commit.date),
                duration: this.getDurationFromCommit(commit),
                focus: this.getFocusFromCommitMessage(commit.message),
                motivation: this.getMotivationFromCommitMessage(commit.message),
                repositoryId
            });
            await this.neo4jService.createCommitWorkPatternRelationship(commit.hash, patternId, repositoryId);
        }

        for (const email of uniqueAuthors) {
            const authorInfo = await this.gitHistoryService.getAuthorInfo(email);
            const stats = commits.filter(commit => commit.email === email);
            await this.neo4jService.createContributorNode({
                name: authorInfo.name,
                email: authorInfo.email,
                commits: stats.length,
                insertions: stats.reduce((sum, commit) => sum + commit.insertions, 0),
                deletions: stats.reduce((sum, commit) => sum + commit.deletions, 0),
                firstCommit: stats.length ? stats[stats.length - 1].date : new Date(),
                lastCommit: stats.length ? stats[0].date : new Date(),
                repositoryId
            });

            const workPatterns = await this.gitHistoryService.getWorkPatterns(email, 20);
            for (const pattern of workPatterns) {
                await this.neo4jService.createWorkPatternNode({
                    timeOfDay: pattern.timeOfDay,
                    dayOfWeek: pattern.dayOfWeek,
                    duration: pattern.duration,
                    focus: pattern.focus,
                    motivation: pattern.motivation,
                    repositoryId
                });
            }
        }

        for (const [author, collaborators] of collaborations) {
            for (const collaborator of collaborators) {
                await this.neo4jService.createCollaborationRelationship(
                    author, 
                    collaborator, 
                    repositoryId, 
                    collaborators.length
                );
            }
        }

        const teams = new Set<string>();
        for (const email of uniqueAuthors) {
            const authorInfo = await this.gitHistoryService.getAuthorInfo(email);
            if (authorInfo.team) {
                teams.add(authorInfo.team);
            }
        }

        for (const teamName of teams) {
            let teamSize = 0;
            for (const email of uniqueAuthors) {
                const info = await this.gitHistoryService.getAuthorInfo(email);
                if (info.team === teamName) {
                    teamSize++;
                }
            }
            await this.neo4jService.createTeamNode({
                name: teamName,
                size: teamSize,
                repositoryId
            });
        }

        for (const email of uniqueAuthors) {
            const authorInfo = await this.gitHistoryService.getAuthorInfo(email);
            if (authorInfo.team) {
                await this.neo4jService.createAuthorTeamRelationship(email, authorInfo.team, repositoryId);
            }
        }
        return {
            commitCount: commits.length,
            contributorCount: uniqueAuthors.size
        };
    }

    private toPatternId(date: Date): string {
        return `${this.getTimeOfDay(date)}_${this.getDayOfWeek(date)}`;
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

    private getDurationFromCommit(commit: { insertions: number; deletions: number }): string {
        const total = commit.insertions + commit.deletions;
        if (total > 500) return 'long session';
        if (total > 100) return 'medium session';
        return 'quick fix';
    }

    private getFocusFromCommitMessage(message: string): string {
        const msg = message.toLowerCase();
        if (msg.includes('refactor') || msg.includes('architecture')) return 'deep work';
        if (msg.includes('review') || msg.includes('feedback')) return 'review';
        if (msg.includes('meeting') || msg.includes('sync')) return 'meetings';
        return 'development';
    }

    private getMotivationFromCommitMessage(message: string): string {
        const msg = message.toLowerCase();
        if (msg.includes('deadline') || msg.includes('urgent')) return 'deadline pressure';
        if (msg.includes('request') || msg.includes('feature')) return 'feature request';
        if (msg.includes('bug') || msg.includes('issue')) return 'bug report';
        if (msg.includes('improve') || msg.includes('optimize')) return 'improvement';
        return 'routine work';
    }

    private async analyzeDependencies(repoPath: string, repositoryId: string): Promise<void> {
        const dependencies = await this.dependencyAnalyzer.analyzeDeps(repoPath);
        
        for (const dependency of dependencies) {
            await this.neo4jService.createDependencyNode({
                name: dependency.name,
                version: dependency.version,
                type: dependency.type,
                repositoryId
            });
        }
    }

    private async analyzeComplexity(repoPath: string, repositoryId: string): Promise<void> {
        const files = await this.githubService.getAllFiles(repoPath);
        
        for (const file of files) {
            if (file.content) {
                const metrics = this.complexityAnalyzer.calculateAllMetrics(file.content);
                
                await this.neo4jService.createComplexityNode({
                    filePath: file.path,
                    cyclomaticComplexity: metrics.cyclomaticComplexity,
                    linesOfCode: metrics.linesOfCode,
                    maintainabilityIndex: metrics.maintainabilityIndex,
                    repositoryId
                });
            }
        }
    }
}
