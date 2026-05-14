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
        `,

        TEAM_COLLABORATION: `
            MATCH (t:Team {repositoryId: $repositoryId})<-[:MEMBER_OF]-(a:Contributor)-[:AUTHORED]->(c:Commit)-[:MODIFIED]->(f:File)
            RETURN t.name as team, f.path as filePath, count(c) as commits
            ORDER BY team, commits DESC
        `,

        CROSS_TEAM_COLLABORATION: `
            MATCH (a1:Contributor {repositoryId: $repositoryId})-[:COLLABORATES_WITH]->(a2:Contributor {repositoryId: $repositoryId})
            MATCH (a1)-[:MEMBER_OF]->(t1:Team {repositoryId: $repositoryId})
            MATCH (a2)-[:MEMBER_OF]->(t2:Team {repositoryId: $repositoryId})
            WHERE t1.name <> t2.name
            RETURN t1.name as team1, t2.name as team2, count(*) as collaborations
            ORDER BY collaborations DESC
        `,

        CODE_OWNERSHIP: `
            MATCH (a:Contributor {repositoryId: $repositoryId})-[:AUTHORED]->(c:Commit)-[:MODIFIED]->(f:File)
            RETURN f.path as filePath, a.name as author, a.team as team, count(c) as expertiseScore
            ORDER BY filePath, expertiseScore DESC
        `,

        WORK_PATTERNS: `
            MATCH (t:Team {repositoryId: $repositoryId})<-[:MEMBER_OF]-(a:Contributor)-[:AUTHORED]->(c:Commit)-[:FOLLOWS_PATTERN]->(w:WorkPattern {repositoryId: $repositoryId})
            WHERE w.focus = "deep work"
            RETURN t.name as team, w.timeOfDay as timeOfDay, avg(c.effort) as productivity
            ORDER BY team, productivity DESC
        `,

        TEAM_PRODUCTIVITY: `
            MATCH (t:Team {repositoryId: $repositoryId})<-[:MEMBER_OF]-(a:Contributor)-[:AUTHORED]->(c:Commit)
            RETURN t.name as team, 
                   count(c) as totalCommits,
                   avg(c.insertions) as avgInsertions,
                   avg(c.deletions) as avgDeletions,
                   count(DISTINCT a) as teamSize
            ORDER BY totalCommits DESC
        `,

        AUTHOR_EXPERTISE: `
            MATCH (a:Contributor {repositoryId: $repositoryId})-[:AUTHORED]->(c:Commit)-[:MODIFIED]->(f:File)
            WITH a, f, count(c) as commits
            MATCH (a)-[:MEMBER_OF]->(t:Team {repositoryId: $repositoryId})
            RETURN a.name as author, 
                   a.team as team,
                   a.role as role,
                   collect({file: f.path, commits: commits})[0..5] as topFiles,
                   sum(commits) as totalCommits
            ORDER BY totalCommits DESC
        `,

        COMMIT_MOTIVATION: `
            MATCH (c:Commit {repositoryId: $repositoryId})-[:FOLLOWS_PATTERN]->(w:WorkPattern {repositoryId: $repositoryId})
            RETURN w.motivation as motivation, 
                   w.focus as focus,
                   count(c) as frequency
            ORDER BY frequency DESC
        `,

        CROSS_SHARED_DEPS: `
            MATCH (r1:Repository)-[s:SHARES_DEPENDENCY]->(r2:Repository)
            RETURN r1.fullName as repo1, r2.fullName as repo2, s.dependency as dependency, s.versions as versions
            ORDER BY s.dependency
        `,

        CROSS_SHARED_CONTRIBS: `
            MATCH (r1:Repository)-[o:SHARED_CONTRIBUTOR]->(r2:Repository)
            RETURN r1.fullName as repo1, r2.fullName as repo2, o.name as contributor, o.email as email
            ORDER BY o.name
        `,

        CROSS_SHARED_LANGS: `
            MATCH (r1:Repository)-[l:SHARED_LANGUAGE]->(r2:Repository)
            RETURN r1.fullName as repo1, r2.fullName as repo2, l.extension as extension, l.fileCount as fileCount
            ORDER BY l.fileCount DESC
        `
    };
}
