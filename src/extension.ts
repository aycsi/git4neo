import * as vscode from 'vscode';
import { Neo4jService } from './services/neo4jService';
import { GitHubService } from './services/githubService';
import { RepositoryAnalyzer } from './services/repositoryAnalyzer';
import { BatchProcessor } from './services/batchProcessor';
import { BatchManagerView } from './views/batchManager';

export function activate(context: vscode.ExtensionContext) {
    const neo4jService = new Neo4jService();
    const githubService = new GitHubService();
    const repositoryAnalyzer = new RepositoryAnalyzer(neo4jService, githubService);
    const batchProcessor = new BatchProcessor(neo4jService, githubService, repositoryAnalyzer);
    const batchManagerView = new BatchManagerView(batchProcessor);

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'git4neo.testExtension';
    context.subscriptions.push(statusBar);

    const updStatus = () => {
        if (neo4jService.connected) {
            statusBar.text = '$(database) Neo4j: Connected';
            statusBar.tooltip = 'Git4Neo - Connected to Neo4j';
        } else {
            statusBar.text = '$(circle-slash) Neo4j: Disconnected';
            statusBar.tooltip = 'Git4Neo - Not connected. Click to check status.';
        }
        statusBar.show();
    };
    updStatus();

    const testExtension = vscode.commands.registerCommand('git4neo.testExtension', async () => {
        try {
            vscode.window.showInformationMessage('Git4Neo extension initialized');
            
            const config = vscode.workspace.getConfiguration('git4neo');
            const neo4jUri = config.get<string>('neo4jUri', 'bolt://localhost:7687');
            const githubToken = config.get<string>('githubToken', '');
            
            const status = `Neo4j URI: ${neo4jUri}\nGitHub Token: ${githubToken ? 'Configured' : 'Not configured'}`;
            vscode.window.showInformationMessage(`Extension Status:\n${status}`);
            
        } catch (error) {
            vscode.window.showErrorMessage(`Test failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    const connectRepository = vscode.commands.registerCommand('git4neo.connectRepository', async (uri?: vscode.Uri) => {
        let repoUrl: string | undefined;
        
        if (uri) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {
                try {
                    const git = require('simple-git')(workspaceFolder.uri.fsPath);
                    const remotes = await git.getRemotes(true);
                    if (remotes.length > 0 && remotes[0].refs.fetch) {
                        repoUrl = remotes[0].refs.fetch.replace('.git', '');
                    }
                } catch (error) {
                }
            }
        }
        
        if (!repoUrl) {
            repoUrl = await vscode.window.showInputBox({
                prompt: 'Enter GitHub repository URL',
                placeHolder: 'https://github.com/username/repository'
            });
        }

        if (!repoUrl) {
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Connecting repository to Neo4j...',
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0 });
                await repositoryAnalyzer.analyzeRepository(repoUrl!, undefined, progress);
                progress.report({ increment: 100 });
            });

            vscode.window.showInformationMessage('Repository connected to Neo4j');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to connect repository: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            updStatus();
        }
    });

    const connectMultipleRepositories = vscode.commands.registerCommand('git4neo.connectMultipleRepositories', async (uri?: vscode.Uri) => {
        batchManagerView.show();
    });

    const viewGraph = vscode.commands.registerCommand('git4neo.viewGraph', async (uri?: vscode.Uri) => {
        try {
            const browserUri = await neo4jService.getNeo4jBrowserUri();
            await vscode.env.openExternal(vscode.Uri.parse(browserUri));
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open Neo4j browser: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    const openBatchManager = vscode.commands.registerCommand('git4neo.openBatchManager', (uri?: vscode.Uri) => {
        batchManagerView.show();
    });

    const runQuery = vscode.commands.registerCommand('git4neo.runQuery', async () => {
        const query = await vscode.window.showInputBox({
            prompt: 'Enter Cypher query',
            placeHolder: 'MATCH (n) RETURN n LIMIT 10'
        });
        
        if (query) {
            try {
                await neo4jService.connect();
                const results = await neo4jService.executeQuery(query);
                await neo4jService.disconnect();
                
                vscode.window.showInformationMessage(`Query returned ${results.length} results`);
            } catch (error) {
                vscode.window.showErrorMessage(`Query failed: ${error instanceof Error ? error.message : String(error)}`);
            } finally {
                updStatus();
            }
        }
    });

    const setupWizard = vscode.commands.registerCommand('git4neo.setupWizard', async () => {
        const cfg = vscode.workspace.getConfiguration('git4neo');

        const uri = await vscode.window.showInputBox({
            prompt: '1/4 Neo4j URI',
            value: cfg.get<string>('neo4jUri', 'bolt://localhost:7687'),
            placeHolder: 'bolt://localhost:7687'
        });
        if (!uri) { return; }

        const user = await vscode.window.showInputBox({
            prompt: '2/4 Neo4j Username',
            value: cfg.get<string>('neo4jUsername', 'neo4j'),
            placeHolder: 'neo4j'
        });
        if (!user) { return; }

        const pw = await vscode.window.showInputBox({
            prompt: '3/4 Neo4j Password',
            password: true,
            placeHolder: 'Enter your Neo4j password'
        });
        if (pw === undefined) { return; }

        const ghToken = await vscode.window.showInputBox({
            prompt: '4/4 GitHub Token (optional, press Enter to skip)',
            value: cfg.get<string>('githubToken', ''),
            placeHolder: 'ghp_...'
        });

        await cfg.update('neo4jUri', uri, vscode.ConfigurationTarget.Global);
        await cfg.update('neo4jUsername', user, vscode.ConfigurationTarget.Global);
        await cfg.update('neo4jPassword', pw, vscode.ConfigurationTarget.Global);
        if (ghToken) {
            await cfg.update('githubToken', ghToken, vscode.ConfigurationTarget.Global);
        }

        try {
            await neo4jService.connect();
            vscode.window.showInformationMessage('Setup complete - Neo4j connection verified!');
        } catch (error) {
            vscode.window.showErrorMessage(`Settings saved but connection failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            updStatus();
        }
    });

    context.subscriptions.push(testExtension, connectRepository, connectMultipleRepositories, viewGraph, openBatchManager, runQuery, setupWizard);
}

export function deactivate() {}
