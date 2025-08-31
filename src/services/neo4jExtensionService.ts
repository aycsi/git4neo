import * as vscode from 'vscode';

export interface Neo4jExtensionConfig {
    isInstalled: boolean;
    isConnected: boolean;
    connectionDetails?: {
        uri: string;
        username: string;
        database: string;
    };
}

export class Neo4jExtensionService {
    private static readonly NEO4J_EXTENSION_ID = 'neo4j.neo4j';

    static async checkNeo4jExtension(): Promise<Neo4jExtensionConfig> {
        const extension = vscode.extensions.getExtension(this.NEO4J_EXTENSION_ID);
        
        if (!extension) {
            return {
                isInstalled: false,
                isConnected: false
            };
        }

        if (!extension.isActive) {
            try {
                await extension.activate();
            } catch (error) {
                return {
                    isInstalled: true,
                    isConnected: false
                };
            }
        }


        const connectionDetails = await this.getNeo4jConnectionDetails();
        
        return {
            isInstalled: true,
            isConnected: !!connectionDetails,
            connectionDetails
        };
    }

    private static async getNeo4jConnectionDetails(): Promise<{ uri: string; username: string; database: string } | undefined> {
        try {
            const workspaceState = vscode.workspace.getConfiguration('neo4j');
            
            const uri = workspaceState.get<string>('uri');
            const username = workspaceState.get<string>('username');
            const database = workspaceState.get<string>('database') || 'neo4j';

            if (uri && username) {
                return { uri, username, database };
            }


            const neo4jExtension = vscode.extensions.getExtension(this.NEO4J_EXTENSION_ID);
            if (neo4jExtension && neo4jExtension.exports) {

                const api = neo4jExtension.exports;
                if (api && typeof api.getConnectionStatus === 'function') {
                    const status = await api.getConnectionStatus();
                    if (status && status.connected) {
                        return {
                            uri: status.uri || 'bolt://localhost:7687',
                            username: status.username || 'neo4j',
                            database: status.database || 'neo4j'
                        };
                    }
                }
            }

            return undefined;
        } catch (error) {
            return undefined;
        }
    }

    static async promptForNeo4jInstallation(): Promise<boolean> {
        const install = await vscode.window.showInformationMessage(
            'Neo4j extension is not installed. Would you like to install it for better integration?',
            'Install Neo4j Extension',
            'Use Manual Configuration'
        );

        if (install === 'Install Neo4j Extension') {
            await vscode.commands.executeCommand('workbench.extensions.installExtension', this.NEO4J_EXTENSION_ID);
            return true;
        }

        return false;
    }

    static async promptForNeo4jConnection(): Promise<boolean> {
        const connect = await vscode.window.showInformationMessage(
            'Neo4j extension is installed but not connected. Would you like to connect to Neo4j?',
            'Connect to Neo4j',
            'Use Manual Configuration'
        );

        if (connect === 'Connect to Neo4j') {
            await vscode.commands.executeCommand('neo4j.connect');
            return true;
        }

        return false;
    }

    static async openNeo4jBrowser(): Promise<void> {
        const neo4jConfig = await this.checkNeo4jExtension();
        
        if (neo4jConfig.isInstalled && neo4jConfig.isConnected) {
            await vscode.commands.executeCommand('neo4j.openBrowser');
        } else {
            const config = vscode.workspace.getConfiguration('git4neo');
            const uri = config.get<string>('neo4jUri', 'bolt://localhost:7687');
            const browserUri = uri.replace('bolt://', 'http://').replace(':7687', ':7474');
            await vscode.env.openExternal(vscode.Uri.parse(browserUri));
        }
    }

    static async getConnectionStatus(): Promise<string> {
        const config = await this.checkNeo4jExtension();
        
        if (!config.isInstalled) {
            return 'Neo4j extension not installed';
        }
        
        if (!config.isConnected) {
            return 'Neo4j extension not connected';
        }
        
        return `Connected to ${config.connectionDetails?.uri}`;
    }

    static async suggestConfiguration(): Promise<void> {
        const config = await this.checkNeo4jExtension();
        
        if (!config.isInstalled) {
            const install = await vscode.window.showInformationMessage(
                'For better integration, consider installing the Neo4j extension.',
                'Install Neo4j Extension',
                'Dismiss'
            );
            
            if (install === 'Install Neo4j Extension') {
                await vscode.commands.executeCommand('workbench.extensions.installExtension', this.NEO4J_EXTENSION_ID);
            }
        } else if (!config.isConnected) {
            const connect = await vscode.window.showInformationMessage(
                'Neo4j extension is installed but not connected. Connect to use Git4Neo with Neo4j extension.',
                'Connect to Neo4j',
                'Dismiss'
            );
            
            if (connect === 'Connect to Neo4j') {
                await vscode.commands.executeCommand('neo4j.connect');
            }
        }
    }
}
