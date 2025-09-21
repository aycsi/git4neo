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

    async connect(): Promise<void> {
        const neo4jConfig = await Neo4jExtensionService.checkNeo4jExtension();
        
        if (neo4jConfig.isInstalled && neo4jConfig.isConnected && neo4jConfig.connectionDetails) {
            const { uri, username } = neo4jConfig.connectionDetails;
            const password = await this.getPasswordFromNeo4jExtension();
            
            try {
                this.driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
                await this.driver.verifyConnectivity();
                return;
            } catch (error) {
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
            return config.get<string>('password') || 'password';
        } catch (error) {
            return 'password';
        }
    }

    async disconnect(): Promise<void> {
        // Close all sessions in the pool
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

    async createCommitNode(commitData: {
        hash: string;
        message: string;
        author: string;
        date: Date;
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
                    c.date = datetime($date),
                    c.createdAt = datetime()
                MERGE (r)-[:HAS_COMMIT]->(c)
                RETURN c.hash as id
            `, commitData);

            return result.records[0].get('id');
        } finally {
            this.releaseSession(session);
        }
    }
        if (!this.driver) {
            throw new Error('Not connected to Neo4j');
        }

        const session = this.getSession();
        try {
            const batchSize = 100;
            for (let i = 0; i < nodes.length; i += batchSize) {
                const batch = nodes.slice(i, i + batchSize);
                const queries = batch.map(node => {
                    switch (node.type) {
                        case 'repository':
                            return `
                                MERGE (r:Repository {fullName: $fullName})
                                SET r.name = $name,
                                    r.description = $description,
                                    r.language = $language,
                                    r.stars = $stars,
                                    r.forks = $forks,
                                    r.url = $url,
                                    r.createdAt = datetime()
                            `;
                        case 'file':
                            return `
                                MATCH (r:Repository {fullName: $repositoryId})
                                MERGE (f:File {path: $path, repositoryId: $repositoryId})
                                SET f.name = $name,
                                    f.extension = $extension,
                                    f.size = $size,
                                    f.createdAt = datetime()
                                MERGE (r)-[:CONTAINS]->(f)
                            `;
                        default:
                            return '';
                    }
                }).filter(q => q);

                if (queries.length > 0) {
                    await session.run(`UNWIND $batch AS item ${queries.join(' ')}`, { batch });
                }
            }
        } finally {
            this.releaseSession(session);
        }
    }
}
