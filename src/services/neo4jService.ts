import * as vscode from 'vscode';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { Neo4jExtensionService } from './neo4jExtensionService';

export interface GraphNode {
    id: string;
    labels: string[];
    properties: Record<string, any>;
}

export interface GraphRelationship {
    id: string;
    type: string;
    startNodeId: string;
    endNodeId: string;
    properties: Record<string, any>;
}

export class Neo4jService {
    private driver: Driver | null = null;
    private sessionPool: Session[] = [];
    private maxPoolSize = 5;

    get connected(): boolean {
        return this.driver !== null;
    }

    async connect(): Promise<void> {
        if (this.driver) {
            try {
                await this.driver.verifyConnectivity();
                return;
            } catch (error) {
                await this.disconnect();
            }
        }

        const neo4jConfig = await Neo4jExtensionService.checkNeo4jExtension();
        
        if (neo4jConfig.isInstalled && neo4jConfig.isConnected && neo4jConfig.connectionDetails) {
            const { uri, username } = neo4jConfig.connectionDetails;
            const password = await this.getPasswordFromNeo4jExtension();
            
            try {
                this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
                await this.driver.verifyConnectivity();
                return;
            } catch (error) {
                vscode.window.showWarningMessage(`Neo4j extension connection failed, falling back to settings: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const config = vscode.workspace.getConfiguration('git4neo');
        const uri = config.get<string>('neo4jUri', 'bolt://localhost:7687');
        const username = config.get<string>('neo4jUsername', 'neo4j');
        const password = config.get<string>('neo4jPassword', 'password');

        try {
            this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
            await this.driver.verifyConnectivity();
        } catch (error) {
            throw new Error(`Failed to connect to Neo4j: ${error}`);
        }
    }

    private getSession(): Session {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }
        
        if (this.sessionPool.length > 0) {
            return this.sessionPool.pop()!;
        }
        
        return this.driver.session();
    }

    private releaseSession(session: Session): void {
        if (this.sessionPool.length < this.maxPoolSize) {
            this.sessionPool.push(session);
        } else {
            session.close();
        }
    }

    private async getPasswordFromNeo4jExtension(): Promise<string> {
        try {
            const config = vscode.workspace.getConfiguration('neo4j');
            return config.get<string>('password') || '';
        } catch (error) {
            return '';
        }
    }

    async disconnect(): Promise<void> {
        for (const session of this.sessionPool) {
            await session.close();
        }
        this.sessionPool = [];
        
        if (this.driver) {
            await this.driver.close();
            this.driver = null;
        }
    }

    async createRepositoryNode(repoData: {
        name: string;
        fullName: string;
        description: string;
        language: string;
        stars: number;
        forks: number;
        url: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            const result = await session.run(`
                MERGE (r:Repository {fullName: $fullName})
                SET r.name = $name,
                    r.description = $description,
                    r.language = $language,
                    r.stars = $stars,
                    r.forks = $forks,
                    r.url = $url,
                    r.createdAt = datetime()
                RETURN r.fullName as id
            `, repoData);

            return result.records[0].get('id');
        } finally {
            await session.close();
        }
    }

    async createFileNode(fileData: {
        path: string;
        name: string;
        extension: string;
        size: number;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (f:File {path: $path, repositoryId: $repositoryId})
                SET f.name = $name,
                    f.extension = $extension,
                    f.size = $size,
                    f.createdAt = datetime()
                MERGE (r)-[:CONTAINS]->(f)
                RETURN f.path as id
            `, fileData);

            return result.records[0].get('id');
        } finally {
            await session.close();
        }
    }

    async createFunctionNode(functionData: {
        name: string;
        filePath: string;
        lineNumber: number;
        parameters: string[];
        returnType: string;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (f:File {path: $filePath, repositoryId: $repositoryId})
                MERGE (func:Function {name: $name, filePath: $filePath, repositoryId: $repositoryId})
                SET func.lineNumber = $lineNumber,
                    func.parameters = $parameters,
                    func.returnType = $returnType,
                    func.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(func)
                RETURN func.name + '_' + func.filePath as id
            `, functionData);

            return result.records[0].get('id');
        } finally {
            await session.close();
        }
    }

    async createHookNode(hookData: {
        name: string;
        filePath: string;
        lineNumber: number;
        type: string;
        dependencies?: string[];
        returnType?: string;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (f:File {path: $filePath, repositoryId: $repositoryId})
                MERGE (h:Hook {name: $name, filePath: $filePath, repositoryId: $repositoryId})
                SET h.lineNumber = $lineNumber,
                    h.type = $type,
                    h.dependencies = $dependencies,
                    h.returnType = $returnType,
                    h.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(h)
                RETURN h.name + '_' + h.filePath as id
            `, hookData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createDecoratorNode(decoratorData: {
        name: string;
        filePath: string;
        lineNumber: number;
        target: string;
        arguments?: string[];
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (f:File {path: $filePath, repositoryId: $repositoryId})
                MERGE (d:Decorator {name: $name, filePath: $filePath, repositoryId: $repositoryId})
                SET d.lineNumber = $lineNumber,
                    d.target = $target,
                    d.arguments = $arguments,
                    d.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(d)
                RETURN d.name + '_' + d.filePath as id
            `, decoratorData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createClassNode(classData: {
        name: string;
        filePath: string;
        lineNumber: number;
        methods: string[];
        properties: string[];
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (f:File {path: $filePath, repositoryId: $repositoryId})
                MERGE (c:Class {name: $name, filePath: $filePath, repositoryId: $repositoryId})
                SET c.lineNumber = $lineNumber,
                    c.methods = $methods,
                    c.properties = $properties,
                    c.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(c)
                RETURN c.name + '_' + c.filePath as id
            `, classData);

            return result.records[0].get('id');
        } finally {
            await session.close();
        }
    }

    async createImportRelationship(fromFile: string, toFile: string, repositoryId: string): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            await session.run(`
                MATCH (f1:File {path: $fromFile, repositoryId: $repositoryId})
                MATCH (f2:File {path: $toFile, repositoryId: $repositoryId})
                MERGE (f1)-[:IMPORTS]->(f2)
            `, { fromFile, toFile, repositoryId });
        } finally {
            await session.close();
        }
    }

    async createFunctionCallRelationship(fromFunction: string, toFunction: string, repositoryId: string): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            await session.run(`
                MATCH (f1:Function {name: $fromFunction, repositoryId: $repositoryId})
                MATCH (f2:Function {name: $toFunction, repositoryId: $repositoryId})
                MERGE (f1)-[:CALLS]->(f2)
            `, { fromFunction, toFunction, repositoryId });
        } finally {
            await session.close();
        }
    }

    async createSimilarityRelationship(repo1: string, repo2: string, similarityScore: number): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            await session.run(`
                MATCH (r1:Repository {fullName: $repo1})
                MATCH (r2:Repository {fullName: $repo2})
                MERGE (r1)-[:SIMILAR_TO {score: $similarityScore}]->(r2)
            `, { repo1, repo2, similarityScore });
        } finally {
            await session.close();
        }
    }

    async getNeo4jBrowserUri(): Promise<string> {
        const neo4jConfig = await Neo4jExtensionService.checkNeo4jExtension();
        
        if (neo4jConfig.isInstalled && neo4jConfig.isConnected && neo4jConfig.connectionDetails) {
            const { uri } = neo4jConfig.connectionDetails;
            return uri.replace('bolt://', 'http://').replace(':7687', ':7474');
        }

        const config = vscode.workspace.getConfiguration('git4neo');
        const uri = config.get<string>('neo4jUri', 'bolt://localhost:7687');
        return uri.replace('bolt://', 'http://').replace(':7687', ':7474');
    }

    async getRepositoryStats(repositoryId: string): Promise<any> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.driver.session();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                OPTIONAL MATCH (r)-[:CONTAINS]->(f:File)
                OPTIONAL MATCH (f)-[:DEFINES]->(func:Function)
                OPTIONAL MATCH (f)-[:DEFINES]->(c:Class)
                RETURN count(f) as fileCount,
                       count(func) as functionCount,
                       count(c) as classCount
            `, { repositoryId });

            return result.records[0].toObject();
        } finally {
            await session.close();
        }
    }

    async createCommitNode(commitData: {
        hash: string;
        message: string;
        author: string;
        email: string;
        date: Date;
        insertions: number;
        deletions: number;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (c:Commit {hash: $hash, repositoryId: $repositoryId})
                SET c.message = $message,
                    c.author = $author,
                    c.email = $email,
                    c.date = datetime($date),
                    c.insertions = $insertions,
                    c.deletions = $deletions,
                    c.createdAt = datetime()
                MERGE (r)-[:HAS_COMMIT]->(c)
                RETURN c.hash as id
            `, commitData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createBranchNode(branchData: {
        name: string;
        isCurrent: boolean;
        lastCommit: string;
        commitCount: number;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (b:Branch {name: $name, repositoryId: $repositoryId})
                SET b.isCurrent = $isCurrent,
                    b.lastCommit = $lastCommit,
                    b.commitCount = $commitCount,
                    b.createdAt = datetime()
                MERGE (r)-[:HAS_BRANCH]->(b)
                RETURN b.name as id
            `, branchData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createContributorNode(contributorData: {
        name: string;
        email: string;
        commits: number;
        insertions: number;
        deletions: number;
        firstCommit: Date;
        lastCommit: Date;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (c:Contributor {email: $email, repositoryId: $repositoryId})
                SET c.name = $name,
                    c.commits = $commits,
                    c.insertions = $insertions,
                    c.deletions = $deletions,
                    c.firstCommit = datetime($firstCommit),
                    c.lastCommit = datetime($lastCommit),
                    c.createdAt = datetime()
                MERGE (r)-[:HAS_CONTRIBUTOR]->(c)
                RETURN c.email as id
            `, contributorData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createCommitFileRelationship(commitHash: string, filePath: string, repositoryId: string): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            await session.run(`
                MATCH (c:Commit {hash: $commitHash, repositoryId: $repositoryId})
                MATCH (f:File {path: $filePath, repositoryId: $repositoryId})
                MERGE (c)-[:MODIFIED]->(f)
            `, { commitHash, filePath, repositoryId });
        } finally {
            this.releaseSession(session);
        }
    }

    async createCommitAuthorRelationship(commitHash: string, authorEmail: string, repositoryId: string): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            await session.run(`
                MATCH (c:Commit {hash: $commitHash, repositoryId: $repositoryId})
                MATCH (a:Contributor {email: $authorEmail, repositoryId: $repositoryId})
                MERGE (c)-[:AUTHORED_BY]->(a)
            `, { commitHash, authorEmail, repositoryId });
        } finally {
            this.releaseSession(session);
        }
    }

    async createBatchNodes(nodes: any[]): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const grouped: Record<string, any[]> = {};
        for (const node of nodes) {
            if (!grouped[node.type]) {
                grouped[node.type] = [];
            }
            grouped[node.type].push(node);
        }

        const queryMap: Record<string, string> = {
            repository: `
                UNWIND $batch AS item
                MERGE (r:Repository {fullName: item.fullName})
                SET r.name = item.name, r.description = item.description,
                    r.language = item.language, r.stars = item.stars,
                    r.forks = item.forks, r.url = item.url, r.createdAt = datetime()
            `,
            file: `
                UNWIND $batch AS item
                MATCH (r:Repository {fullName: item.repositoryId})
                MERGE (f:File {path: item.path, repositoryId: item.repositoryId})
                SET f.name = item.name, f.extension = item.extension,
                    f.size = item.size, f.createdAt = datetime()
                MERGE (r)-[:CONTAINS]->(f)
            `,
            function: `
                UNWIND $batch AS item
                MATCH (f:File {path: item.filePath, repositoryId: item.repositoryId})
                MERGE (func:Function {name: item.name, filePath: item.filePath, repositoryId: item.repositoryId})
                SET func.lineNumber = item.lineNumber, func.parameters = item.parameters,
                    func.returnType = item.returnType, func.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(func)
            `,
            class: `
                UNWIND $batch AS item
                MATCH (f:File {path: item.filePath, repositoryId: item.repositoryId})
                MERGE (c:Class {name: item.name, filePath: item.filePath, repositoryId: item.repositoryId})
                SET c.lineNumber = item.lineNumber, c.methods = item.methods,
                    c.properties = item.properties, c.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(c)
            `,
            hook: `
                UNWIND $batch AS item
                MATCH (f:File {path: item.filePath, repositoryId: item.repositoryId})
                MERGE (h:Hook {name: item.name, filePath: item.filePath, repositoryId: item.repositoryId})
                SET h.lineNumber = item.lineNumber, h.type = item.hookType,
                    h.dependencies = item.dependencies, h.returnType = item.returnType, h.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(h)
            `,
            decorator: `
                UNWIND $batch AS item
                MATCH (f:File {path: item.filePath, repositoryId: item.repositoryId})
                MERGE (d:Decorator {name: item.name, filePath: item.filePath, repositoryId: item.repositoryId})
                SET d.lineNumber = item.lineNumber, d.target = item.target,
                    d.arguments = item.arguments, d.createdAt = datetime()
                MERGE (f)-[:DEFINES]->(d)
            `,
            commit: `
                UNWIND $batch AS item
                MATCH (r:Repository {fullName: item.repositoryId})
                MERGE (c:Commit {hash: item.hash, repositoryId: item.repositoryId})
                SET c.message = item.message, c.author = item.author, c.email = item.email,
                    c.date = datetime(item.date), c.insertions = item.insertions,
                    c.deletions = item.deletions, c.createdAt = datetime()
                MERGE (r)-[:HAS_COMMIT]->(c)
            `,
            branch: `
                UNWIND $batch AS item
                MATCH (r:Repository {fullName: item.repositoryId})
                MERGE (b:Branch {name: item.name, repositoryId: item.repositoryId})
                SET b.isCurrent = item.isCurrent, b.lastCommit = item.lastCommit,
                    b.commitCount = item.commitCount, b.createdAt = datetime()
                MERGE (r)-[:HAS_BRANCH]->(b)
            `,
            contributor: `
                UNWIND $batch AS item
                MATCH (r:Repository {fullName: item.repositoryId})
                MERGE (c:Contributor {email: item.email, repositoryId: item.repositoryId})
                SET c.name = item.name, c.commits = item.commits,
                    c.insertions = item.insertions, c.deletions = item.deletions,
                    c.firstCommit = datetime(item.firstCommit), c.lastCommit = datetime(item.lastCommit),
                    c.createdAt = datetime()
                MERGE (r)-[:HAS_CONTRIBUTOR]->(c)
            `,
            dependency: `
                UNWIND $batch AS item
                MATCH (r:Repository {fullName: item.repositoryId})
                MERGE (d:Dependency {name: item.name, repositoryId: item.repositoryId})
                SET d.version = item.version, d.type = item.depType, d.createdAt = datetime()
                MERGE (r)-[:HAS_DEPENDENCY]->(d)
            `,
            complexity: `
                UNWIND $batch AS item
                MATCH (f:File {path: item.filePath, repositoryId: item.repositoryId})
                MERGE (c:Complexity {filePath: item.filePath, repositoryId: item.repositoryId})
                SET c.cyclomaticComplexity = item.cyclomaticComplexity,
                    c.linesOfCode = item.linesOfCode, c.maintainabilityIndex = item.maintainabilityIndex,
                    c.createdAt = datetime()
                MERGE (f)-[:HAS_COMPLEXITY]->(c)
            `
        };

        const session = this.getSession();
        try {
            const batchSize = 100;
            for (const [type, items] of Object.entries(grouped)) {
                const query = queryMap[type];
                if (!query) {
                    vscode.window.showWarningMessage(`Unknown batch node type: ${type}`);
                    continue;
                }
                for (let i = 0; i < items.length; i += batchSize) {
                    await session.run(query, { batch: items.slice(i, i + batchSize) });
                }
            }
        } finally {
            this.releaseSession(session);
        }
    }

    async createDependencyNode(dependencyData: {
        name: string;
        version: string;
        type: string;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (d:Dependency {name: $name, repositoryId: $repositoryId})
                SET d.version = $version,
                    d.type = $type,
                    d.createdAt = datetime()
                MERGE (r)-[:HAS_DEPENDENCY]->(d)
                RETURN d.name as id
            `, dependencyData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createComplexityNode(complexityData: {
        filePath: string;
        cyclomaticComplexity: number;
        linesOfCode: number;
        maintainabilityIndex: number;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (f:File {path: $filePath, repositoryId: $repositoryId})
                MERGE (c:Complexity {filePath: $filePath, repositoryId: $repositoryId})
                SET c.cyclomaticComplexity = $cyclomaticComplexity,
                    c.linesOfCode = $linesOfCode,
                    c.maintainabilityIndex = $maintainabilityIndex,
                    c.createdAt = datetime()
                MERGE (f)-[:HAS_COMPLEXITY]->(c)
                RETURN c.filePath as id
            `, complexityData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createAuthorNode(authorData: {
        name: string;
        email: string;
        team?: string;
        role?: string;
        timezone?: string;
        joinDate?: Date;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (a:Author {email: $email, repositoryId: $repositoryId})
                SET a.name = $name,
                    a.team = $team,
                    a.role = $role,
                    a.timezone = $timezone,
                    a.joinDate = datetime($joinDate),
                    a.createdAt = datetime()
                MERGE (r)-[:HAS_AUTHOR]->(a)
                RETURN a.email as id
            `, authorData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createTeamNode(teamData: {
        name: string;
        size?: number;
        lead?: string;
        focus?: string;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (t:Team {name: $name, repositoryId: $repositoryId})
                SET t.size = $size,
                    t.lead = $lead,
                    t.focus = $focus,
                    t.createdAt = datetime()
                MERGE (r)-[:HAS_TEAM]->(t)
                RETURN t.name as id
            `, teamData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createWorkPatternNode(patternData: {
        timeOfDay: string;
        dayOfWeek: string;
        duration: string;
        focus: string;
        motivation: string;
        repositoryId: string;
    }): Promise<string> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r:Repository {fullName: $repositoryId})
                MERGE (w:WorkPattern {
                    timeOfDay: $timeOfDay,
                    dayOfWeek: $dayOfWeek,
                    repositoryId: $repositoryId
                })
                SET w.duration = $duration,
                    w.focus = $focus,
                    w.motivation = $motivation,
                    w.createdAt = datetime()
                MERGE (r)-[:HAS_PATTERN]->(w)
                RETURN w.timeOfDay + '_' + w.dayOfWeek as id
            `, patternData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }

    async createAuthorTeamRelationship(authorEmail: string, teamName: string, repositoryId: string): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            await session.run(`
                MATCH (a:Author {email: $authorEmail, repositoryId: $repositoryId})
                MATCH (t:Team {name: $teamName, repositoryId: $repositoryId})
                MERGE (a)-[:MEMBER_OF]->(t)
            `, { authorEmail, teamName, repositoryId });
        } finally {
            this.releaseSession(session);
        }
    }

    async createCollaborationRelationship(author1Email: string, author2Email: string, repositoryId: string, strength: number): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            await session.run(`
                MATCH (a1:Author {email: $author1Email, repositoryId: $repositoryId})
                MATCH (a2:Author {email: $author2Email, repositoryId: $repositoryId})
                MERGE (a1)-[:COLLABORATES_WITH {strength: $strength}]->(a2)
            `, { author1Email, author2Email, repositoryId, strength });
        } finally {
            this.releaseSession(session);
        }
    }

    async createCommitWorkPatternRelationship(commitHash: string, patternId: string, repositoryId: string): Promise<void> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            await session.run(`
                MATCH (c:Commit {hash: $commitHash, repositoryId: $repositoryId})
                MATCH (w:WorkPattern {repositoryId: $repositoryId})
                WHERE w.timeOfDay + '_' + w.dayOfWeek = $patternId
                MERGE (c)-[:FOLLOWS_PATTERN]->(w)
            `, { commitHash, patternId, repositoryId });
        } finally {
            this.releaseSession(session);
        }
    }

    async getTeamCollaborationInsights(repositoryId: string): Promise<any[]> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (t:Team {repositoryId: $repositoryId})-[:MEMBER_OF]-(a:Author)-[:AUTHORED]->(c:Commit)-[:MODIFIED]->(f:File)
                RETURN t.name as team, f.path as filePath, count(c) as commits
                ORDER BY team, commits DESC
            `, { repositoryId });

            return result.records.map(record => record.toObject());
        } finally {
            this.releaseSession(session);
        }
    }

    async getCrossTeamCollaboration(repositoryId: string): Promise<any[]> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (a1:Author {repositoryId: $repositoryId})-[:COLLABORATES_WITH]->(a2:Author {repositoryId: $repositoryId})
                MATCH (a1)-[:MEMBER_OF]->(t1:Team {repositoryId: $repositoryId})
                MATCH (a2)-[:MEMBER_OF]->(t2:Team {repositoryId: $repositoryId})
                WHERE t1.name <> t2.name
                RETURN t1.name as team1, t2.name as team2, count(*) as collaborations
                ORDER BY collaborations DESC
            `, { repositoryId });

            return result.records.map(record => record.toObject());
        } finally {
            this.releaseSession(session);
        }
    }

    async getCodeOwnershipInsights(repositoryId: string): Promise<any[]> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (a:Author {repositoryId: $repositoryId})-[:AUTHORED]->(c:Commit)-[:MODIFIED]->(f:File)
                RETURN f.path as filePath, a.name as author, a.team as team, count(c) as expertiseScore
                ORDER BY filePath, expertiseScore DESC
            `, { repositoryId });

            return result.records.map(record => record.toObject());
        } finally {
            this.releaseSession(session);
        }
    }

    async getWorkPatternInsights(repositoryId: string): Promise<any[]> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (t:Team {repositoryId: $repositoryId})-[:MEMBER_OF]-(a:Author)-[:AUTHORED]->(c:Commit)-[:FOLLOWS_PATTERN]->(w:WorkPattern {repositoryId: $repositoryId})
                WHERE w.focus = "deep work"
                RETURN t.name as team, w.timeOfDay as timeOfDay, avg(c.effort) as productivity
                ORDER BY team, productivity DESC
            `, { repositoryId });

            return result.records.map(record => record.toObject());
        } finally {
            this.releaseSession(session);
        }
    }

    async executeQuery(query: string, params?: any): Promise<any[]> {
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const result = await session.run(query, params);
            return result.records.map(record => record.toObject());
        } finally {
            this.releaseSession(session);
        }
    }

    async linkSharedDeps(): Promise<number> {
        if (!this.driver) { throw new Error('Not connected to Neo4j'); }
        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r1:Repository)-[:HAS_DEPENDENCY]->(d1:Dependency)
                MATCH (r2:Repository)-[:HAS_DEPENDENCY]->(d2:Dependency)
                WHERE r1.fullName < r2.fullName AND d1.name = d2.name
                MERGE (r1)-[s:SHARES_DEPENDENCY {dependency: d1.name}]->(r2)
                SET s.versions = [d1.version, d2.version], s.updatedAt = datetime()
                RETURN count(s) as cnt
            `);
            return result.records[0]?.get('cnt')?.toNumber() || 0;
        } finally {
            this.releaseSession(session);
        }
    }

    async linkContribOverlap(): Promise<number> {
        if (!this.driver) { throw new Error('Not connected to Neo4j'); }
        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r1:Repository)-[:HAS_CONTRIBUTOR]->(c1:Contributor)
                MATCH (r2:Repository)-[:HAS_CONTRIBUTOR]->(c2:Contributor)
                WHERE r1.fullName < r2.fullName AND c1.email = c2.email
                MERGE (r1)-[o:SHARED_CONTRIBUTOR {email: c1.email}]->(r2)
                SET o.name = c1.name, o.updatedAt = datetime()
                RETURN count(o) as cnt
            `);
            return result.records[0]?.get('cnt')?.toNumber() || 0;
        } finally {
            this.releaseSession(session);
        }
    }

    async linkLangOverlap(): Promise<number> {
        if (!this.driver) { throw new Error('Not connected to Neo4j'); }
        const session = this.getSession();
        try {
            const result = await session.run(`
                MATCH (r1:Repository)-[:CONTAINS]->(f1:File)
                MATCH (r2:Repository)-[:CONTAINS]->(f2:File)
                WHERE r1.fullName < r2.fullName AND f1.extension = f2.extension
                WITH r1, r2, f1.extension as ext, count(*) as fileCount
                MERGE (r1)-[l:SHARED_LANGUAGE {extension: ext}]->(r2)
                SET l.fileCount = fileCount, l.updatedAt = datetime()
                RETURN count(l) as cnt
            `);
            return result.records[0]?.get('cnt')?.toNumber() || 0;
        } finally {
            this.releaseSession(session);
        }
    }
}