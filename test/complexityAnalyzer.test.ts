import { ComplexityAnalyzer } from '../src/services/complexityAnalyzer';

describe('ComplexityAnalyzer', () => {
    let analyzer: ComplexityAnalyzer;

    beforeEach(() => {
        analyzer = new ComplexityAnalyzer();
    });

    test('should calculate cyclomatic complexity correctly', () => {
        const code = `
            function test() {
                if (true) {
                    return 1;
                }
                return 0;
            }
        `;
        
        const complexity = analyzer.calculateCyclomaticComplexity(code);
        expect(complexity).toBe(2);
    });

    test('should calculate lines of code correctly', () => {
        const code = `
            function test() {
                return 1;
            }
        `;
        
        const loc = analyzer.calculateLinesOfCode(code);
        expect(loc).toBe(2);
    });
});
