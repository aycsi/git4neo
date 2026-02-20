import * as fs from 'fs';
import * as path from 'path';

export interface DependencyInfo {
    name: string;
    version: string;
    type: 'dependency' | 'devDependency' | 'peerDependency';
}

export class DependencyAnalyzer {
    async analyzeDeps(repoPath: string): Promise<DependencyInfo[]> {
        const results: DependencyInfo[] = [];
        results.push(...await this.analyzePackageJson(repoPath));
        results.push(...this.parseReqsTxt(repoPath));
        results.push(...this.parsePyproject(repoPath));
        results.push(...this.parseGoMod(repoPath));
        results.push(...this.parseCargoToml(repoPath));
        results.push(...this.parseGemfile(repoPath));
        return results;
    }

    async analyzePackageJson(repoPath: string): Promise<DependencyInfo[]> {
        const filePath = path.join(repoPath, 'package.json');
        if (!fs.existsSync(filePath)) { return []; }

        try {
            const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const deps: DependencyInfo[] = [];

            for (const [name, version] of Object.entries(pkg.dependencies || {})) {
                deps.push({ name, version: version as string, type: 'dependency' });
            }
            for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
                deps.push({ name, version: version as string, type: 'devDependency' });
            }
            for (const [name, version] of Object.entries(pkg.peerDependencies || {})) {
                deps.push({ name, version: version as string, type: 'peerDependency' });
            }
            return deps;
        } catch { return []; }
    }

    private parseReqsTxt(repoPath: string): DependencyInfo[] {
        const filePath = path.join(repoPath, 'requirements.txt');
        if (!fs.existsSync(filePath)) { return []; }

        try {
            const lines = fs.readFileSync(filePath, 'utf8').split('\n');
            const deps: DependencyInfo[] = [];
            for (const raw of lines) {
                const l = raw.trim();
                if (!l || l.startsWith('#') || l.startsWith('-')) { continue; }
                const m = l.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
                if (m) { deps.push({ name: m[1], version: m[2]?.trim() || '*', type: 'dependency' }); }
            }
            return deps;
        } catch { return []; }
    }

    private parsePyproject(repoPath: string): DependencyInfo[] {
        const filePath = path.join(repoPath, 'pyproject.toml');
        if (!fs.existsSync(filePath)) { return []; }

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const deps: DependencyInfo[] = [];
            const depBlock = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
            if (depBlock) {
                const entries = depBlock[1].match(/"([^"]+)"/g) || [];
                for (const entry of entries) {
                    const raw = entry.replace(/"/g, '');
                    const m = raw.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
                    if (m) { deps.push({ name: m[1], version: m[2]?.trim() || '*', type: 'dependency' }); }
                }
            }
            return deps;
        } catch { return []; }
    }

    private parseGoMod(repoPath: string): DependencyInfo[] {
        const filePath = path.join(repoPath, 'go.mod');
        if (!fs.existsSync(filePath)) { return []; }

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const deps: DependencyInfo[] = [];
            const reqBlock = content.match(/require\s*\(([\s\S]*?)\)/);
            if (reqBlock) {
                const lines = reqBlock[1].split('\n');
                for (const line of lines) {
                    const m = line.trim().match(/^(\S+)\s+(v\S+)/);
                    if (m) { deps.push({ name: m[1], version: m[2], type: 'dependency' }); }
                }
            }
            const singleReqs = content.match(/^require\s+(\S+)\s+(v\S+)/gm);
            if (singleReqs) {
                for (const req of singleReqs) {
                    const m = req.match(/^require\s+(\S+)\s+(v\S+)/);
                    if (m) { deps.push({ name: m[1], version: m[2], type: 'dependency' }); }
                }
            }
            return deps;
        } catch { return []; }
    }

    private parseCargoToml(repoPath: string): DependencyInfo[] {
        const filePath = path.join(repoPath, 'Cargo.toml');
        if (!fs.existsSync(filePath)) { return []; }

        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const deps: DependencyInfo[] = [];
            const sections: Array<{ pattern: RegExp; type: 'dependency' | 'devDependency' }> = [
                { pattern: /\[dependencies\]([\s\S]*?)(?=\n\[|$)/, type: 'dependency' },
                { pattern: /\[dev-dependencies\]([\s\S]*?)(?=\n\[|$)/, type: 'devDependency' },
            ];
            for (const { pattern, type } of sections) {
                const block = content.match(pattern);
                if (!block) { continue; }
                const lines = block[1].split('\n');
                for (const line of lines) {
                    const simple = line.match(/^(\S+)\s*=\s*"([^"]+)"/);
                    if (simple) { deps.push({ name: simple[1], version: simple[2], type }); continue; }
                    const complex = line.match(/^(\S+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/);
                    if (complex) { deps.push({ name: complex[1], version: complex[2], type }); }
                }
            }
            return deps;
        } catch { return []; }
    }

    private parseGemfile(repoPath: string): DependencyInfo[] {
        const filePath = path.join(repoPath, 'Gemfile');
        if (!fs.existsSync(filePath)) { return []; }

        try {
            const lines = fs.readFileSync(filePath, 'utf8').split('\n');
            const deps: DependencyInfo[] = [];
            for (const raw of lines) {
                const l = raw.trim();
                if (!l.startsWith('gem ')) { continue; }
                const m = l.match(/gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
                if (m) { deps.push({ name: m[1], version: m[2] || '*', type: 'dependency' }); }
            }
            return deps;
        } catch { return []; }
    }
}
