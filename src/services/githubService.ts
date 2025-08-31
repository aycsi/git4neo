import * as vscode from 'vscode';
import { Octokit } from 'octokit';
import simpleGit from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface RepositoryInfo {
    name: string;
    fullName: string;
    description: string;
    language: string;
    stars: number;
    forks: number;
    url: string;
    cloneUrl: string;
}

export interface FileInfo {
    path: string;
    name: string;
    extension: string;
    size: number;
    content: string;
}

export interface FunctionInfo {
    name: string;
    lineNumber: number;
    parameters: string[];
    returnType: string;
}

export interface ClassInfo {
    name: string;
    lineNumber: number;
    methods: string[];
    properties: string[];
}

export class GitHubService {
    private octokit: Octokit | null = null;
    private tempDir: string = '';

    constructor() {
        const config = vscode.workspace.getConfiguration('git4neo');
        const token = config.get<string>('githubToken');
        
        if (token) {
            this.octokit = new Octokit({ auth: token });
        }
    }

    async getRepositoryInfo(repoUrl: string): Promise<RepositoryInfo> {
        const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) {
            throw new Error('Invalid GitHub repository URL');
        }

        const [, owner, repo] = match;
        
        if (!this.octokit) {
            throw new Error('GitHub token not configured');
        }

        try {
            const response = await this.octokit.rest.repos.get({
                owner,
                repo
            });

            const data = response.data;
            return {
                name: data.name,
                fullName: data.full_name,
                description: data.description || '',
                language: data.language || '',
                stars: data.stargazers_count,
                forks: data.forks_count,
                url: data.html_url,
                cloneUrl: data.clone_url
            };
        } catch (error) {
            throw new Error(`Failed to fetch repository info: ${error}`);
        }
    }

    async cloneRepository(cloneUrl: string): Promise<string> {
        const tempDir = path.join(os.tmpdir(), `git4neo_${Date.now()}`);
        this.tempDir = tempDir;

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        try {
            const git = simpleGit(tempDir);
            await git.clone(cloneUrl, tempDir);
            return tempDir;
        } catch (error) {
            throw new Error(`Failed to clone repository: ${error}`);
        }
    }

    async cleanup(): Promise<void> {
        if (this.tempDir && fs.existsSync(this.tempDir)) {
            try {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
                    } catch (error) {
        }
        }
    }

    async getAllFiles(repoPath: string): Promise<FileInfo[]> {
        const files: FileInfo[] = [];
        const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt'];

        const walkDir = (dir: string): void => {
            const items = fs.readdirSync(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                
                if (stat.isDirectory()) {
                    if (!item.startsWith('.') && item !== 'node_modules' && item !== 'vendor' && item !== 'target') {
                        walkDir(fullPath);
                    }
                } else if (stat.isFile()) {
                    const ext = path.extname(item).toLowerCase();
                    if (extensions.includes(ext)) {
                        const relativePath = path.relative(repoPath, fullPath);
                        try {
                            const content = fs.readFileSync(fullPath, 'utf8');
                            files.push({
                                path: relativePath,
                                name: item,
                                extension: ext,
                                size: stat.size,
                                content
                            });
                        } catch (error) {
                        }
                    }
                }
            }
        };

        walkDir(repoPath);
        return files;
    }

    extractFunctions(content: string, filePath: string): FunctionInfo[] {
        const functions: FunctionInfo[] = [];
        const lines = content.split('\n');

        const functionPatterns = [
            /function\s+(\w+)\s*\(([^)]*)\)\s*:?\s*(\w*)/g,
            /const\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/g,
            /let\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/g,
            /var\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>/g,
            /(\w+)\s*\(([^)]*)\)\s*{/g,
            /def\s+(\w+)\s*\(([^)]*)\)/g,
            /public\s+\w+\s+(\w+)\s*\(([^)]*)\)/g,
            /private\s+\w+\s+(\w+)\s*\(([^)]*)\)/g
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            for (const pattern of functionPatterns) {
                const matches = line.matchAll(pattern);
                for (const match of matches) {
                    const name = match[1];
                    const params = match[2] ? match[2].split(',').map(p => p.trim()).filter(p => p) : [];
                    const returnType = match[3] || '';
                    
                    functions.push({
                        name,
                        lineNumber: i + 1,
                        parameters: params,
                        returnType
                    });
                }
            }
        }

        return functions;
    }

    extractClasses(content: string, filePath: string): ClassInfo[] {
        const classes: ClassInfo[] = [];
        const lines = content.split('\n');

        const classPatterns = [
            /class\s+(\w+)/g,
            /interface\s+(\w+)/g
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            for (const pattern of classPatterns) {
                const matches = line.matchAll(pattern);
                for (const match of matches) {
                    const className = match[1];
                    const methods: string[] = [];
                    const properties: string[] = [];

                    let j = i + 1;
                    let braceCount = 0;
                    let inClass = false;

                    while (j < lines.length) {
                        const currentLine = lines[j];
                        
                        if (currentLine.includes('{')) {
                            braceCount++;
                            inClass = true;
                        }
                        
                        if (currentLine.includes('}')) {
                            braceCount--;
                            if (braceCount === 0) break;
                        }

                        if (inClass) {
                            const methodMatch = currentLine.match(/(\w+)\s*\([^)]*\)\s*{?/);
                            if (methodMatch) {
                                methods.push(methodMatch[1]);
                            }

                            const propertyMatch = currentLine.match(/(\w+)\s*[:=]/);
                            if (propertyMatch) {
                                properties.push(propertyMatch[1]);
                            }
                        }
                        
                        j++;
                    }

                    classes.push({
                        name: className,
                        lineNumber: i + 1,
                        methods,
                        properties
                    });
                }
            }
        }

        return classes;
    }

    extractImports(content: string): string[] {
        const imports: string[] = [];
        const lines = content.split('\n');

        const importPatterns = [
            /import\s+.*from\s+['"]([^'"]+)['"]/g,
            /import\s+['"]([^'"]+)['"]/g,
            /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            /using\s+([^;]+);/g,
            /#include\s+[<"]([^>"]+)[>"]/g
        ];

        for (const line of lines) {
            for (const pattern of importPatterns) {
                const matches = line.matchAll(pattern);
                for (const match of matches) {
                    imports.push(match[1]);
                }
            }
        }

        return imports;
    }

    extractFunctionCalls(content: string): string[] {
        const calls: string[] = [];
        const lines = content.split('\n');

        const callPattern = /(\w+)\s*\(/g;

        for (const line of lines) {
            const matches = line.matchAll(callPattern);
            for (const match of matches) {
                const functionName = match[1];
                if (!['if', 'for', 'while', 'switch', 'catch', 'function', 'class', 'const', 'let', 'var'].includes(functionName)) {
                    calls.push(functionName);
                }
            }
        }

        return calls;
    }

    calculateSimilarity(repo1: string, repo2: string): number {
        const commonExtensions = this.getCommonExtensions(repo1, repo2);
        const commonLanguages = this.getCommonLanguages(repo1, repo2);
        
        const extensionScore = commonExtensions.length / Math.max(this.getExtensions(repo1).length, this.getExtensions(repo2).length);
        const languageScore = commonLanguages.length / Math.max(this.getLanguages(repo1).length, this.getLanguages(repo2).length);
        
        return (extensionScore + languageScore) / 2;
    }

    private getCommonExtensions(repo1: string, repo2: string): string[] {
        const ext1 = this.getExtensions(repo1);
        const ext2 = this.getExtensions(repo2);
        return ext1.filter(ext => ext2.includes(ext));
    }

    private getCommonLanguages(repo1: string, repo2: string): string[] {
        const lang1 = this.getLanguages(repo1);
        const lang2 = this.getLanguages(repo2);
        return lang1.filter(lang => lang2.includes(lang));
    }

    private getExtensions(repo: string): string[] {
        return [];
    }

    private getLanguages(repo: string): string[] {
        return [];
    }
}
