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
    content?: string;
}

export interface StreamingConfig {
    maxFileSize: number;
    enableStreaming: boolean;
    chunkSize: number;
}

export interface FunctionInfo {
    name: string;
    lineNumber: number;
    parameters: string[];
    returnType: string;
    type: string;
    isAsync: boolean;
    decorators: string[];
    generics: string[];
}

export interface ClassInfo {
    name: string;
    lineNumber: number;
    methods: string[];
    properties: string[];
    type: string;
    decorators: string[];
    extends: string;
    implements: string[];
}

export interface HookInfo {
    name: string;
    filePath: string;
    lineNumber: number;
    type: string;
    dependencies?: string[];
    returnType?: string;
}

export interface DecoratorInfo {
    name: string;
    filePath: string;
    lineNumber: number;
    target: string;
    arguments?: string[];
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
                vscode.window.showWarningMessage(`Failed to clean up temp directory ${this.tempDir}: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                this.tempDir = '';
            }
        }
    }

    async getAllFiles(repoPath: string, config?: StreamingConfig): Promise<FileInfo[]> {
        const files: FileInfo[] = [];
        const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt'];
        const maxFileSize = config?.maxFileSize || 1024 * 1024; // 1MB default
        const enableStreaming = config?.enableStreaming ?? true;

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
                        
                        const fileInfo: FileInfo = {
                            path: relativePath,
                            name: item,
                            extension: ext,
                            size: stat.size
                        };

                        // Only load content for small files or when streaming is disabled
                        if (!enableStreaming || stat.size <= maxFileSize) {
                            try {
                                fileInfo.content = fs.readFileSync(fullPath, 'utf8');
                            } catch (error) {
                                // Skip files that can't be read
                                continue;
                            }
                        }

                        files.push(fileInfo);
                    }
                }
            }
        };

        walkDir(repoPath);
        return files;
    }

    async *streamFiles(repoPath: string, config?: StreamingConfig): AsyncGenerator<FileInfo, void, unknown> {
        const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt'];
        const maxFileSize = config?.maxFileSize || 1024 * 1024;
        const enableStreaming = config?.enableStreaming ?? true;

        const walkDir = async function* (dir: string): AsyncGenerator<FileInfo, void, unknown> {
            const items = fs.readdirSync(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                
                if (stat.isDirectory()) {
                    if (!item.startsWith('.') && item !== 'node_modules' && item !== 'vendor' && item !== 'target') {
                        yield* walkDir(fullPath);
                    }
                } else if (stat.isFile()) {
                    const ext = path.extname(item).toLowerCase();
                    if (extensions.includes(ext)) {
                        const relativePath = path.relative(repoPath, fullPath);
                        
                        const fileInfo: FileInfo = {
                            path: relativePath,
                            name: item,
                            extension: ext,
                            size: stat.size
                        };

                        // Only load content for small files or when streaming is disabled
                        if (!enableStreaming || stat.size <= maxFileSize) {
                            try {
                                fileInfo.content = fs.readFileSync(fullPath, 'utf8');
                            } catch (error) {
                                // Skip files that can't be read
                                continue;
                            }
                        }

                        yield fileInfo;
                    }
                }
            }
        };

        yield* walkDir(repoPath);
    }

    async readFileContent(filePath: string, repoPath: string): Promise<string> {
        const fullPath = path.join(repoPath, filePath);
        try {
            return fs.readFileSync(fullPath, 'utf8');
        } catch (error) {
            throw new Error(`Failed to read file ${filePath}: ${error}`);
        }
    }

    async readFileContentChunked(filePath: string, repoPath: string, chunkSize: number = 8192): Promise<AsyncGenerator<string, void, unknown>> {
        const fullPath = path.join(repoPath, filePath);
        
        return async function* () {
            try {
                const stream = fs.createReadStream(fullPath, { encoding: 'utf8', highWaterMark: chunkSize });
                
                for await (const chunk of stream) {
                    yield chunk;
                }
            } catch (error) {
                throw new Error(`Failed to read file ${filePath}: ${error}`);
            }
        }();
    }

    extractFunctions(content: string, filePath: string): FunctionInfo[] {
        const functions: FunctionInfo[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
                continue;
            }

            const decorators = this.getDecorators(line);
            
            const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*<([^>]*)>?\s*\(([^)]*)\)\s*:?\s*([^{]*)/);
            if (funcMatch) {
                functions.push({
                    name: funcMatch[1],
                    lineNumber: i + 1,
                    parameters: this.parseParams(funcMatch[3]),
                    returnType: funcMatch[4].trim(),
                    type: 'function',
                    isAsync: trimmed.includes('async'),
                    decorators,
                    generics: funcMatch[2] ? funcMatch[2].split(',').map(g => g.trim()) : []
                });
                continue;
            }

            const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*<([^>]*)>?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*:?\s*([^=]*)\s*=>/);
            if (arrowMatch) {
                functions.push({
                    name: arrowMatch[1],
                    lineNumber: i + 1,
                    parameters: this.parseParams(arrowMatch[3]),
                    returnType: arrowMatch[4].trim(),
                    type: 'arrow',
                    isAsync: trimmed.includes('async'),
                    decorators,
                    generics: arrowMatch[2] ? arrowMatch[2].split(',').map(g => g.trim()) : []
                });
                continue;
            }

            const componentMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*<([^>]*)>?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*:?\s*(?:React\.)?(?:FC|FunctionComponent)/);
            if (componentMatch) {
                functions.push({
                    name: componentMatch[1],
                    lineNumber: i + 1,
                    parameters: this.parseParams(componentMatch[3]),
                    returnType: 'React.FC',
                    type: 'component',
                    isAsync: trimmed.includes('async'),
                    decorators,
                    generics: componentMatch[2] ? componentMatch[2].split(',').map(g => g.trim()) : []
                });
                continue;
            }

            const methodMatch = trimmed.match(/^(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*<([^>]*)>?\s*\(([^)]*)\)\s*:?\s*([^{]*)/);
            if (methodMatch && !trimmed.includes('=') && !trimmed.includes('=>')) {
                functions.push({
                    name: methodMatch[1],
                    lineNumber: i + 1,
                    parameters: this.parseParams(methodMatch[3]),
                    returnType: methodMatch[4].trim(),
                    type: 'method',
                    isAsync: trimmed.includes('async'),
                    decorators,
                    generics: methodMatch[2] ? methodMatch[2].split(',').map(g => g.trim()) : []
                });
                continue;
            }

            if (decorators.some(d => d.includes('Controller'))) {
                const controllerMatch = trimmed.match(/^(?:export\s+)?(?:@\w+.*\n\s*)*class\s+(\w+)/);
                if (controllerMatch) {
                    functions.push({
                        name: controllerMatch[1],
                        lineNumber: i + 1,
                        parameters: [],
                        returnType: 'void',
                        type: 'controller',
                        isAsync: false,
                        decorators,
                        generics: []
                    });
                }
            }

            if (decorators.some(d => d.includes('Injectable'))) {
                const serviceMatch = trimmed.match(/^(?:export\s+)?(?:@\w+.*\n\s*)*class\s+(\w+)/);
                if (serviceMatch) {
                    functions.push({
                        name: serviceMatch[1],
                        lineNumber: i + 1,
                        parameters: [],
                        returnType: 'void',
                        type: 'service',
                        isAsync: false,
                        decorators,
                        generics: []
                    });
                }
            }

            const hookMatch = trimmed.match(/(use\w+)\s*\(/);
            if (hookMatch) {
                functions.push({
                    name: hookMatch[1],
                    lineNumber: i + 1,
                    parameters: [],
                    returnType: 'any',
                    type: 'hook',
                    isAsync: false,
                    decorators: [],
                    generics: []
                });
            }
        }

        return functions;
    }

    extractClasses(content: string, filePath: string): ClassInfo[] {
        const classes: ClassInfo[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
                continue;
            }

            const decorators = this.getDecorators(line);
            
            const classMatch = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)\s*<([^>]*)>?\s*(?:extends\s+(\w+))?\s*(?:implements\s+([^{]+))?/);
            if (classMatch) {
                const className = classMatch[1];
                const generics = classMatch[2] ? classMatch[2].split(',').map(g => g.trim()) : [];
                const extendsClass = classMatch[3] || '';
                const implementsInterfaces = classMatch[4] ? classMatch[4].split(',').map(i => i.trim()) : [];

                let classType = 'class';
                if (decorators.some(d => d.includes('Component'))) classType = 'component';
                else if (decorators.some(d => d.includes('Injectable'))) classType = 'service';
                else if (decorators.some(d => d.includes('Controller'))) classType = 'controller';
                else if (decorators.some(d => d.includes('Module'))) classType = 'module';

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
                        const methodMatch = currentLine.match(/^(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*:?\s*[^{]*/);
                        if (methodMatch && !currentLine.includes('=') && !currentLine.includes('=>')) {
                            methods.push(methodMatch[1]);
                        }

                        const propertyMatch = currentLine.match(/^(?:public|private|protected)?\s*(?:static\s+)?(\w+)\s*[:=]/);
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
                    properties,
                    type: classType,
                    decorators,
                    extends: extendsClass,
                    implements: implementsInterfaces
                });
                continue;
            }

            const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)\s*<([^>]*)>?\s*(?:extends\s+([^{]+))?/);
            if (interfaceMatch) {
                const interfaceName = interfaceMatch[1];
                const generics = interfaceMatch[2] ? interfaceMatch[2].split(',').map(g => g.trim()) : [];
                const extendsInterfaces = interfaceMatch[3] ? interfaceMatch[3].split(',').map(i => i.trim()) : [];

                const methods: string[] = [];
                const properties: string[] = [];

                let j = i + 1;
                let braceCount = 0;
                let inInterface = false;

                while (j < lines.length) {
                    const currentLine = lines[j];
                    
                    if (currentLine.includes('{')) {
                        braceCount++;
                        inInterface = true;
                    }
                    
                    if (currentLine.includes('}')) {
                        braceCount--;
                        if (braceCount === 0) break;
                    }

                    if (inInterface) {
                        const methodMatch = currentLine.match(/(\w+)\s*\([^)]*\)\s*:?\s*[^;]*;/);
                        if (methodMatch) {
                            methods.push(methodMatch[1]);
                        }

                        const propertyMatch = currentLine.match(/(\w+)\s*:\s*[^;]*;/);
                        if (propertyMatch) {
                            properties.push(propertyMatch[1]);
                        }
                    }
                    
                    j++;
                }

                classes.push({
                    name: interfaceName,
                    lineNumber: i + 1,
                    methods,
                    properties,
                    type: 'interface',
                    decorators: [],
                    extends: extendsInterfaces[0] || '',
                    implements: []
                });
            }
        }

        return classes;
    }

    private getDecorators(line: string): string[] {
        const decorators: string[] = [];
        const decoratorMatch = line.match(/@(\w+)/g);
        if (decoratorMatch) {
            decorators.push(...decoratorMatch.map(d => d.substring(1)));
        }
        return decorators;
    }

    private parseParams(paramString: string): string[] {
        if (!paramString.trim()) return [];
        
        const params = paramString.split(',').map(p => {
            const trimmed = p.trim();
            const nameMatch = trimmed.match(/^([^:=\s]+)/);
            return nameMatch ? nameMatch[1] : trimmed;
        }).filter(p => p && p !== 'void');
        
        return params;
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

        const maxExt = Math.max(this.getExtensions(repo1).length, this.getExtensions(repo2).length);
        const maxLang = Math.max(this.getLanguages(repo1).length, this.getLanguages(repo2).length);

        const extensionScore = maxExt > 0 ? commonExtensions.length / maxExt : 0;
        const languageScore = maxLang > 0 ? commonLanguages.length / maxLang : 0;

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
        const exts = new Set<string>();
        const walk = (dir: string) => {
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (['node_modules', '.git', 'vendor', 'target', 'dist', 'build'].includes(entry.name)) { continue; }
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) { walk(full); }
                    else {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (ext) { exts.add(ext); }
                    }
                }
            } catch (_) {}
        };
        walk(repo);
        return Array.from(exts);
    }

    private getLanguages(repo: string): string[] {
        const extLangMap: Record<string, string> = {
            '.js': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
            '.py': 'Python', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
            '.cpp': 'C++', '.c': 'C', '.go': 'Go', '.rs': 'Rust',
            '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.dart': 'Dart',
            '.scala': 'Scala', '.r': 'R', '.m': 'Objective-C', '.lua': 'Lua',
            '.hs': 'Haskell', '.ex': 'Elixir', '.erl': 'Erlang', '.clj': 'Clojure',
            '.sh': 'Shell', '.ps1': 'PowerShell', '.html': 'HTML', '.css': 'CSS',
            '.scss': 'SCSS', '.sql': 'SQL', '.vue': 'Vue', '.svelte': 'Svelte',
        };
        const langs = new Set<string>();
        for (const ext of this.getExtensions(repo)) {
            const lang = extLangMap[ext];
            if (lang) { langs.add(lang); }
        }
        return Array.from(langs);
    }

    extractHooks(content: string, filePath: string): HookInfo[] {
        const hooks: HookInfo[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
                continue;
            }

            const hookMatch = trimmed.match(/(use\w+)\s*\(/);
            if (hookMatch) {
                hooks.push({
                    name: hookMatch[1],
                    filePath: filePath,
                    lineNumber: i + 1,
                    type: 'hook',
                    dependencies: [],
                    returnType: 'any'
                });
            }
        }

        return hooks;
    }

    extractDecorators(content: string, filePath: string): DecoratorInfo[] {
        const decorators: DecoratorInfo[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            if (!trimmed || !trimmed.startsWith('@')) {
                continue;
            }

            const decoratorMatch = trimmed.match(/@(\w+)(?:\(([^)]*)\))?/);
            if (decoratorMatch) {
                const args = decoratorMatch[2] ? decoratorMatch[2].split(',').map(arg => arg.trim()) : [];
                
                decorators.push({
                    name: decoratorMatch[1],
                    filePath: filePath,
                    lineNumber: i + 1,
                    target: '',
                    arguments: args
                });
            }
        }

        return decorators;
    }
}
