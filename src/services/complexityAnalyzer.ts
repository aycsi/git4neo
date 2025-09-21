export interface ComplexityMetrics {
    cyclomaticComplexity: number;
    linesOfCode: number;
    maintainabilityIndex: number;
}

export class ComplexityAnalyzer {
    calculateCyclomaticComplexity(content: string): number {
        const lines = content.split('\n');
        let complexity = 1;
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            if (trimmed.includes('if ') || trimmed.includes('else if')) complexity++;
            if (trimmed.includes('for ') || trimmed.includes('while ')) complexity++;
            if (trimmed.includes('switch ') || trimmed.includes('case ')) complexity++;
            if (trimmed.includes('catch ') || trimmed.includes('&&') || trimmed.includes('||')) complexity++;
        }
        
    calculateLinesOfCode(content: string): number {
        const lines = content.split('\n');
        let loc = 0;
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
                loc++;
            }
        }
        
        return loc;
    }
