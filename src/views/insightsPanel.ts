import * as vscode from 'vscode';
import { Neo4jService } from '../services/neo4jService';
import { Neo4jQueryService } from '../services/neo4jQueryService';

class InsightItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly children?: InsightItem[],
        public readonly detail?: string
    ) {
        super(label, collapsibleState);
        if (detail) {
            this.description = detail;
            this.tooltip = `${label}: ${detail}`;
        }
    }
}

export class InsightsPanel implements vscode.TreeDataProvider<InsightItem> {
    private _onDidChange = new vscode.EventEmitter<InsightItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private repoId: string = '';
    private cache = new Map<string, InsightItem[]>();

    constructor(private neo4j: Neo4jService) {}

    setRepo(repoId: string) {
        this.repoId = repoId;
        this.cache.clear();
        this._onDidChange.fire(undefined);
    }

    refresh() {
        this.cache.clear();
        this._onDidChange.fire(undefined);
    }

    getTreeItem(el: InsightItem): vscode.TreeItem {
        return el;
    }

    async getChildren(el?: InsightItem): Promise<InsightItem[]> {
        if (!this.repoId) {
            return [new InsightItem('No repository selected', vscode.TreeItemCollapsibleState.None, undefined, 'Run "Connect Repository" first')];
        }

        if (!this.neo4j.connected) {
            return [new InsightItem('Not connected to Neo4j', vscode.TreeItemCollapsibleState.None, undefined, 'Run "Setup Wizard"')];
        }

        if (el?.children) {
            return el.children;
        }

        if (!el) {
            return [
                new InsightItem('Hotspots', vscode.TreeItemCollapsibleState.Collapsed),
                new InsightItem('Top Contributors', vscode.TreeItemCollapsibleState.Collapsed),
                new InsightItem('Dependencies', vscode.TreeItemCollapsibleState.Collapsed),
                new InsightItem('Code Quality', vscode.TreeItemCollapsibleState.Collapsed),
                new InsightItem('Recent Commits', vscode.TreeItemCollapsibleState.Collapsed),
            ];
        }

        const cached = this.cache.get(el.label);
        if (cached) { return cached; }

        try {
            const items = await this.fetchItems(el.label);
            this.cache.set(el.label, items);
            return items;
        } catch (error) {
            return [new InsightItem('Failed to load', vscode.TreeItemCollapsibleState.None, undefined, error instanceof Error ? error.message : String(error))];
        }
    }

    private async fetchItems(cat: string): Promise<InsightItem[]> {
        const p = { repositoryId: this.repoId };

        switch (cat) {
            case 'Hotspots': {
                const rows = await this.neo4j.executeQuery(Neo4jQueryService.QUERIES.HOTSPOTS, p);
                if (rows.length === 0) { return [new InsightItem('No data', vscode.TreeItemCollapsibleState.None)]; }
                return rows.map((r: any) => new InsightItem(
                    r.file, vscode.TreeItemCollapsibleState.None, undefined,
                    `complexity: ${r.complexity} | loc: ${r.loc}`
                ));
            }
            case 'Top Contributors': {
                const rows = await this.neo4j.executeQuery(Neo4jQueryService.QUERIES.TOP_CONTRIBUTORS, p);
                if (rows.length === 0) { return [new InsightItem('No data', vscode.TreeItemCollapsibleState.None)]; }
                return rows.map((r: any) => new InsightItem(
                    r.name, vscode.TreeItemCollapsibleState.None, undefined,
                    `${r.commits} commits | +${r.insertions} -${r.deletions}`
                ));
            }
            case 'Dependencies': {
                const rows = await this.neo4j.executeQuery(Neo4jQueryService.QUERIES.DEPENDENCY_GRAPH, p);
                if (rows.length === 0) { return [new InsightItem('No data', vscode.TreeItemCollapsibleState.None)]; }
                return rows.map((r: any) => new InsightItem(
                    r.name, vscode.TreeItemCollapsibleState.None, undefined,
                    `${r.version} (${r.type})`
                ));
            }
            case 'Code Quality': {
                const rows = await this.neo4j.executeQuery(Neo4jQueryService.QUERIES.CODE_QUALITY_SUMMARY, p);
                if (rows.length === 0) { return [new InsightItem('No data', vscode.TreeItemCollapsibleState.None)]; }
                const r = rows[0] as any;
                return [
                    new InsightItem('Files analyzed', vscode.TreeItemCollapsibleState.None, undefined, String(r.totalFiles)),
                    new InsightItem('Avg complexity', vscode.TreeItemCollapsibleState.None, undefined, Number(r.avgComplexity).toFixed(1)),
                    new InsightItem('Avg lines of code', vscode.TreeItemCollapsibleState.None, undefined, Number(r.avgLoc).toFixed(0)),
                    new InsightItem('Avg maintainability', vscode.TreeItemCollapsibleState.None, undefined, Number(r.avgMaintainability).toFixed(1)),
                ];
            }
            case 'Recent Commits': {
                const rows = await this.neo4j.executeQuery(Neo4jQueryService.QUERIES.COMMIT_TRENDS, p);
                if (rows.length === 0) { return [new InsightItem('No data', vscode.TreeItemCollapsibleState.None)]; }
                return rows.slice(0, 15).map((r: any) => new InsightItem(
                    r.message?.substring(0, 60) || '(no message)', vscode.TreeItemCollapsibleState.None, undefined,
                    r.author
                ));
            }
            default:
                return [];
        }
    }
}
