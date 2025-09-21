import { GitHistoryService } from './gitHistoryService';

export interface AnalysisConfig {
    maxFileSize: number;
    enableStreaming: boolean;
    chunkSize: number;
    skipLargeFiles: boolean;
    batchSize: number;
}

export class RepositoryAnalyzer {
    constructor(
        private neo4jService: Neo4jService,
        private githubService: GitHubService
    ) {}

    private gitHistoryService = new GitHistoryService();

    async analyzeRepository(repoUrl: string, config?: Partial<AnalysisConfig>, progress?: vscode.Progress<{ increment?: number; message?: string }>): Promise<void> {
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
        try {
            await this.neo4jService.connect();

            progress?.report({ increment: 10, message: 'Fetching repository information...' });
            const repoInfo = await this.githubService.getRepositoryInfo(repoUrl);

            progress?.report({ increment: 20, message: 'Creating repository node...' });
            const repositoryId = await this.neo4jService.createRepositoryNode(repoInfo);

            progress?.report({ increment: 30, message: 'Cloning repository...' });
            repoPath = await this.githubService.cloneRepository(repoInfo.cloneUrl);

            progress?.report({ increment: 40, message: 'Analyzing files...' });
            
            if (analysisConfig.enableStreaming) {
                await this.analyzeRepositoryStreaming(repoPath, repositoryId, streamingConfig, progress);
            } else {
                await this.analyzeRepositoryBatch(repoPath, repositoryId, streamingConfig, progress);
            }

            progress?.report({ increment: 90, message: 'Cleaning up...' });
            await this.githubService.cleanup();

            progress?.report({ increment: 100, message: 'Analysis finished' });

        } catch (error) {
            await this.githubService.cleanup();
            await this.neo4jService.disconnect();
            throw error;
        } finally {
            await this.neo4jService.disconnect();
        }
    }

    private async analyzeRepositoryStreaming(
        repoPath: string, 
        repositoryId: string, 
        config: StreamingConfig, 
        progress?: vscode.Progress<{ increment?: number; message?: string }>
    ): Promise<void> {
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
    }

    private async analyzeRepositoryBatch(
        repoPath: string, 
        repositoryId: string, 
        config: StreamingConfig, 
        progress?: vscode.Progress<{ increment?: number; message?: string }>
    ): Promise<void> {
        progress?.report({ increment: 10, message: 'Loading all files...' });
        const files = await this.githubService.getAllFiles(repoPath, config);

        progress?.report({ increment: 20, message: 'Creating file nodes...' });
        await this.createFileNodes(files, repositoryId);

        progress?.report({ increment: 30, message: 'Extracting code elements...' });
        await this.extractCodeElements(files, repositoryId);

        progress?.report({ increment: 40, message: 'Creating relationships...' });
        await this.createRelationships(files, repositoryId);
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
            await this.neo4jService.createFileNode({
                path: file.path,
                name: file.name,
                extension: file.extension,
                size: file.size,
                repositoryId
            });
        }
    }

    private async extractCodeElements(files: FileInfo[], repositoryId: string): Promise<void> {
        for (const file of files) {
            if (!file.content) continue;
            
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
            if (!file.content) continue;
            
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

    async analyzeMultipleRepositories(repoUrls: string[]): Promise<void> {
        const repositories: RepositoryInfo[] = [];

        for (const repoUrl of repoUrls) {
            const repoInfo = await this.githubService.getRepositoryInfo(repoUrl);
            repositories.push(repoInfo);
        }

        for (let i = 0; i < repositories.length; i++) {
            for (let j = i + 1; j < repositories.length; j++) {
                const similarity = this.githubService.calculateSimilarity(
                    repositories[i].fullName,
                    repositories[j].fullName
                );
                
                await this.neo4jService.createSimilarityRelationship(
                    repositories[i].fullName,
                    repositories[j].fullName,
                    similarity
                );
            }
        }
    }

    async getRepositoryStatistics(repositoryId: string): Promise<any> {
        await this.neo4jService.connect();
        const stats = await this.neo4jService.getRepositoryStats(repositoryId);
        await this.neo4jService.disconnect();
        return stats;
    }
}
