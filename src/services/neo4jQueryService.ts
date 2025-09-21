export class Neo4jQueryService {
    static readonly QUERIES = {
        HOTSPOTS: `
            MATCH (r:Repository)-[:CONTAINS]->(f:File)-[:HAS_COMPLEXITY]->(c:Complexity)
            WHERE r.fullName = $repositoryId
            RETURN f.path as file, c.cyclomaticComplexity as complexity, c.linesOfCode as loc
            ORDER BY c.cyclomaticComplexity DESC
            LIMIT 10
        `,
        
        TOP_CONTRIBUTORS: `
            MATCH (r:Repository)-[:HAS_CONTRIBUTOR]->(c:Contributor)
            WHERE r.fullName = $repositoryId
            RETURN c.name as name, c.commits as commits, c.insertions as insertions, c.deletions as deletions
            ORDER BY c.commits DESC
            LIMIT 10
        `,
        
        DEPENDENCY_GRAPH: `
            MATCH (r:Repository)-[:HAS_DEPENDENCY]->(d:Dependency)
            WHERE r.fullName = $repositoryId
            RETURN d.name as name, d.version as version, d.type as type
            ORDER BY d.type, d.name
        `,
        
        COMMIT_TRENDS: `
            MATCH (r:Repository)-[:HAS_COMMIT]->(c:Commit)
            WHERE r.fullName = $repositoryId
            RETURN c.date as date, c.author as author, c.message as message
            ORDER BY c.date DESC
            LIMIT 50
        `,
        
        CODE_QUALITY_SUMMARY: `
            MATCH (r:Repository)-[:CONTAINS]->(f:File)-[:HAS_COMPLEXITY]->(c:Complexity)
            WHERE r.fullName = $repositoryId
            RETURN 
                count(f) as totalFiles,
                avg(c.cyclomaticComplexity) as avgComplexity,
                avg(c.linesOfCode) as avgLoc,
                avg(c.maintainabilityIndex) as avgMaintainability
        `
    };
}
