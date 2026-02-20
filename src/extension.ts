import * as vscode from 'vscode';
import { Neo4jService } from './services/neo4jService';
import { GitHubService } from './services/githubService';
import { RepositoryAnalyzer } from './services/repositoryAnalyzer';
import { BatchProcessor } from './services/batchProcessor';
import { BatchManagerView } from './views/batchManager';
import { InsightsPanel } from './views/insightsPanel';
import { GraphView } from './views/graphView';

export function activate(context: vscode.ExtensionContext) {
    const neo4jService = new Neo4jService();
    const githubService = new GitHubService();
    const repositoryAnalyzer = new RepositoryAnalyzer(neo4jService, githubService);
    const batchProcessor = new BatchProcessor(neo4jService, githubService, repositoryAnalyzer);
    const batchManagerView = new BatchManagerView(batchProcessor);
    const insightsPanel = new InsightsPanel(neo4jService);

    vscode.window.registerTreeDataProvider('git4neo.insights', insightsPanel);

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

    const graphView = new GraphView(neo4jService);
    const viewGraph = vscode.commands.registerCommand('git4neo.viewGraph', async () => {
        await graphView.show();
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

    const refreshInsights = vscode.commands.registerCommand('git4neo.refreshInsights', () => {
        insightsPanel.refresh();
    });

    const selectRepo = vscode.commands.registerCommand('git4neo.selectRepo', async () => {
        try {
            await neo4jService.connect();
            const repos = await neo4jService.executeQuery('MATCH (r:Repository) RETURN r.fullName as name ORDER BY r.fullName');
            if (repos.length === 0) {
                vscode.window.showInformationMessage('No repositories found. Connect a repository first.');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                repos.map((r: any) => r.name),
                { placeHolder: 'Select a repository' }
            );
            if (pick) {
                insightsPanel.setRepo(pick);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            updStatus();
        }
    });

    const crossRepoAnalysis = vscode.commands.registerCommand('git4neo.crossRepoAnalysis', async () => {
        try {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Running cross-repo analysis...',
                cancellable: false
            }, async (progress) => {
                return await repositoryAnalyzer.analyzeCrossRepo(progress);
            });
            vscode.window.showInformationMessage(
                `Cross-repo analysis complete: ${result.deps} shared deps, ${result.contribs} shared contributors, ${result.langs} shared languages`
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Cross-repo analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            updStatus();
        }
    });

    const exportInsights = vscode.commands.registerCommand('git4neo.exportInsights', async () => {
        try {
            await neo4jService.connect();
            const repos = await neo4jService.executeQuery('MATCH (r:Repository) RETURN r.fullName as name ORDER BY r.fullName');
            if (repos.length === 0) {
                vscode.window.showInformationMessage('No repositories found.');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                repos.map((r: any) => r.name),
                { placeHolder: 'Select repository to export' }
            );
            if (!pick) { return; }

            const fmt = await vscode.window.showQuickPick(['JSON', 'CSV'], { placeHolder: 'Export format' });
            if (!fmt) { return; }

            const p = { repositoryId: pick };
            const { Neo4jQueryService } = await import('./services/neo4jQueryService');
            const data: Record<string, any[]> = {};
            data.hotspots = await neo4jService.executeQuery(Neo4jQueryService.QUERIES.HOTSPOTS, p);
            data.contributors = await neo4jService.executeQuery(Neo4jQueryService.QUERIES.TOP_CONTRIBUTORS, p);
            data.dependencies = await neo4jService.executeQuery(Neo4jQueryService.QUERIES.DEPENDENCY_GRAPH, p);
            data.codeQuality = await neo4jService.executeQuery(Neo4jQueryService.QUERIES.CODE_QUALITY_SUMMARY, p);
            data.recentCommits = await neo4jService.executeQuery(Neo4jQueryService.QUERIES.COMMIT_TRENDS, p);

            let content: string;
            let ext: string;
            if (fmt === 'JSON') {
                content = JSON.stringify({ repository: pick, exportedAt: new Date().toISOString(), ...data }, null, 2);
                ext = 'json';
            } else {
                const sections: string[] = [];
                for (const [section, rows] of Object.entries(data)) {
                    if (rows.length === 0) { continue; }
                    const keys = Object.keys(rows[0]);
                    sections.push(`# ${section}`);
                    sections.push(keys.join(','));
                    for (const row of rows) {
                        sections.push(keys.map(k => String(row[k] ?? '').replace(/,/g, ';')).join(','));
                    }
                    sections.push('');
                }
                content = sections.join('\n');
                ext = 'csv';
            }

            const uri = await vscode.window.showSaveDialog({
                filters: { [fmt]: [ext] },
                defaultUri: vscode.Uri.file(`git4neo-export-${pick.replace('/', '-')}.${ext}`)
            });
            if (uri) {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                vscode.window.showInformationMessage(`Exported insights for ${pick}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            updStatus();
        }
    });

    context.subscriptions.push(testExtension, connectRepository, connectMultipleRepositories, viewGraph, openBatchManager, runQuery, setupWizard, refreshInsights, selectRepo, crossRepoAnalysis, exportInsights);
}

export function deactivate() {}
