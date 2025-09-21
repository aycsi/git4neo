import * as fs from 'fs';
import * as path from 'path';

export interface DependencyInfo {
    name: string;
    version: string;
    type: 'dependency' | 'devDependency' | 'peerDependency';
}

export class DependencyAnalyzer {
    async analyzePackageJson(repoPath: string): Promise<DependencyInfo[]> {
        const packageJsonPath = path.join(repoPath, 'package.json');
        
        if (!fs.existsSync(packageJsonPath)) {
            return [];
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const dependencies: DependencyInfo[] = [];

        if (packageJson.dependencies) {
            for (const [name, version] of Object.entries(packageJson.dependencies)) {
                dependencies.push({
                    name,
                    version: version as string,
                    type: 'dependency'
                });
            }
        }

        if (packageJson.devDependencies) {
            for (const [name, version] of Object.entries(packageJson.devDependencies)) {
                dependencies.push({
                    name,
                    version: version as string,
                    type: 'devDependency'
                });
            }
        }

        return dependencies;
    }
}
