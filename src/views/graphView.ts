import * as vscode from 'vscode';
import { Neo4jService } from '../services/neo4jService';

export class GraphView {
    private panel: vscode.WebviewPanel | undefined;

    constructor(private neo4j: Neo4jService) {}

    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'git4neo.graphView',
            'Git4Neo Graph',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.webview.html = this.getHtml();
        this.panel.webview.onDidReceiveMessage(this.onMsg.bind(this));
        this.panel.onDidDispose(() => { this.panel = undefined; });
    }

    private async onMsg(msg: any): Promise<void> {
        if (msg.command === 'fetchGraph') {
            try {
                await this.neo4j.connect();
                const nodes = await this.neo4j.executeQuery(`
                    MATCH (n)
                    WHERE n:Repository OR n:File OR n:Contributor OR n:Dependency
                    RETURN id(n) as id, labels(n)[0] as label, 
                           coalesce(n.name, n.fullName, n.path, n.email) as name
                    LIMIT 200
                `);
                const edges = await this.neo4j.executeQuery(`
                    MATCH (a)-[r]->(b)
                    WHERE (a:Repository OR a:File OR a:Contributor OR a:Dependency)
                      AND (b:Repository OR b:File OR b:Contributor OR b:Dependency)
                    RETURN id(a) as src, id(b) as tgt, type(r) as rel
                    LIMIT 500
                `);
                this.panel?.webview.postMessage({
                    command: 'graphData',
                    nodes: nodes.map((n: any) => ({
                        id: typeof n.id?.toNumber === 'function' ? n.id.toNumber() : n.id,
                        label: n.label,
                        name: n.name
                    })),
                    edges: edges.map((e: any) => ({
                        src: typeof e.src?.toNumber === 'function' ? e.src.toNumber() : e.src,
                        tgt: typeof e.tgt?.toNumber === 'function' ? e.tgt.toNumber() : e.tgt,
                        rel: e.rel
                    }))
                });
            } catch (error) {
                this.panel?.webview.postMessage({
                    command: 'error',
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }
        if (msg.command === 'fetchRepo') {
            try {
                await this.neo4j.connect();
                const nodes = await this.neo4j.executeQuery(`
                    MATCH (r:Repository {fullName: $repo})-[rel]-(n)
                    RETURN id(n) as id, labels(n)[0] as label,
                           coalesce(n.name, n.fullName, n.path, n.email) as name
                    LIMIT 150
                `, { repo: msg.repo });
                const repoNode = await this.neo4j.executeQuery(`
                    MATCH (r:Repository {fullName: $repo})
                    RETURN id(r) as id, 'Repository' as label, r.fullName as name
                `, { repo: msg.repo });
                const allNodes = [...repoNode, ...nodes];
                const ids = new Set(allNodes.map((n: any) => typeof n.id?.toNumber === 'function' ? n.id.toNumber() : n.id));
                const edges = await this.neo4j.executeQuery(`
                    MATCH (a)-[r]->(b)
                    WHERE id(a) IN $ids AND id(b) IN $ids
                    RETURN id(a) as src, id(b) as tgt, type(r) as rel
                `, { ids: Array.from(ids) });
                this.panel?.webview.postMessage({
                    command: 'graphData',
                    nodes: allNodes.map((n: any) => ({
                        id: typeof n.id?.toNumber === 'function' ? n.id.toNumber() : n.id,
                        label: n.label,
                        name: n.name
                    })),
                    edges: edges.map((e: any) => ({
                        src: typeof e.src?.toNumber === 'function' ? e.src.toNumber() : e.src,
                        tgt: typeof e.tgt?.toNumber === 'function' ? e.tgt.toNumber() : e.tgt,
                        rel: e.rel
                    }))
                });
            } catch (error) {
                this.panel?.webview.postMessage({
                    command: 'error',
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body { margin:0; overflow:hidden; background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font-family:sans-serif; }
    canvas { display:block; }
    #toolbar { position:absolute; top:10px; left:10px; display:flex; gap:8px; z-index:10; }
    #toolbar button, #toolbar select {
        background:var(--vscode-button-background); color:var(--vscode-button-foreground);
        border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:13px;
    }
    #toolbar button:hover { background:var(--vscode-button-hoverBackground); }
    #toolbar select { background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); }
    #info { position:absolute; bottom:10px; left:10px; font-size:12px; opacity:0.7; }
    #tooltip { position:absolute; display:none; background:var(--vscode-editorWidget-background); border:1px solid var(--vscode-editorWidget-border); padding:6px 10px; border-radius:4px; font-size:12px; pointer-events:none; z-index:20; }
    #status { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); font-size:16px; }
</style>
</head>
<body>
<div id="toolbar">
    <button id="btnAll">All Nodes</button>
    <select id="filterType"><option value="">All Types</option><option value="Repository">Repository</option><option value="File">File</option><option value="Contributor">Contributor</option><option value="Dependency">Dependency</option></select>
    <button id="btnReset">Reset Zoom</button>
</div>
<div id="tooltip"></div>
<div id="info"></div>
<div id="status">Loading graph...</div>
<canvas id="c"></canvas>
<script>
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const info = document.getElementById('info');
const status = document.getElementById('status');

let W, H, nodes = [], edges = [], drag = null, hover = null;
let ox = 0, oy = 0, scale = 1, filterType = '';

const colors = { Repository:'#4A90D9', File:'#50C878', Contributor:'#E8A838', Dependency:'#C850C0' };
const radii = { Repository:18, File:6, Contributor:12, Dependency:10 };

function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
window.addEventListener('resize', resize);
resize();

function sim() {
    for (let i = 0; i < nodes.length; i++) {
        let fx = 0, fy = 0;
        for (let j = 0; j < nodes.length; j++) {
            if (i === j) continue;
            let dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
            let d = Math.sqrt(dx*dx + dy*dy) || 1;
            let rep = 800 / (d * d);
            fx += (dx / d) * rep;
            fy += (dy / d) * rep;
        }
        for (const e of edges) {
            let other = null;
            if (e.srcIdx === i) other = nodes[e.tgtIdx];
            else if (e.tgtIdx === i) other = nodes[e.srcIdx];
            if (!other) continue;
            let dx = nodes[i].x - other.x, dy = nodes[i].y - other.y;
            let d = Math.sqrt(dx*dx + dy*dy) || 1;
            let att = (d - 80) * 0.01;
            fx -= (dx / d) * att;
            fy -= (dy / d) * att;
        }
        fx -= nodes[i].x * 0.001;
        fy -= nodes[i].y * 0.001;
        if (drag !== i) {
            nodes[i].vx = (nodes[i].vx + fx) * 0.85;
            nodes[i].vy = (nodes[i].vy + fy) * 0.85;
            nodes[i].x += nodes[i].vx;
            nodes[i].y += nodes[i].vy;
        }
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W/2 + ox, H/2 + oy);
    ctx.scale(scale, scale);

    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 0.5;
    for (const e of edges) {
        const a = nodes[e.srcIdx], b = nodes[e.tgtIdx];
        if (!a || !b) continue;
        if (filterType && a.label !== filterType && b.label !== filterType) continue;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (filterType && n.label !== filterType) continue;
        const r = radii[n.label] || 8;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = colors[n.label] || '#999';
        if (hover === i) { ctx.fillStyle = '#fff'; }
        ctx.fill();
        if (r >= 10) {
            ctx.fillStyle = '#fff';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            const short = (n.name || '').length > 20 ? n.name.substring(0, 18) + '..' : n.name;
            ctx.fillText(short, n.x, n.y + r + 12);
        }
    }
    ctx.restore();
    requestAnimationFrame(loop);
}

function loop() { sim(); draw(); }

function screenToWorld(sx, sy) {
    return { x: (sx - W/2 - ox) / scale, y: (sy - H/2 - oy) / scale };
}

function findNode(sx, sy) {
    const p = screenToWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i], r = radii[n.label] || 8;
        if (filterType && n.label !== filterType) continue;
        const dx = p.x - n.x, dy = p.y - n.y;
        if (dx*dx + dy*dy < (r+4)*(r+4)) return i;
    }
    return null;
}

let isPanning = false, panStart = {x:0, y:0};

canvas.addEventListener('mousedown', e => {
    const idx = findNode(e.clientX, e.clientY);
    if (idx !== null) { drag = idx; }
    else { isPanning = true; panStart = {x: e.clientX - ox, y: e.clientY - oy}; }
});
canvas.addEventListener('mousemove', e => {
    if (drag !== null) {
        const p = screenToWorld(e.clientX, e.clientY);
        nodes[drag].x = p.x; nodes[drag].y = p.y;
        nodes[drag].vx = 0; nodes[drag].vy = 0;
    } else if (isPanning) {
        ox = e.clientX - panStart.x; oy = e.clientY - panStart.y;
    } else {
        const idx = findNode(e.clientX, e.clientY);
        hover = idx;
        if (idx !== null) {
            const n = nodes[idx];
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 12) + 'px';
            tooltip.style.top = (e.clientY + 12) + 'px';
            tooltip.textContent = n.label + ': ' + n.name;
        } else {
            tooltip.style.display = 'none';
        }
    }
});
canvas.addEventListener('mouseup', () => { drag = null; isPanning = false; });
canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    scale *= factor;
    scale = Math.max(0.1, Math.min(5, scale));
});

document.getElementById('btnAll').addEventListener('click', () => {
    vscode.postMessage({ command: 'fetchGraph' });
});
document.getElementById('filterType').addEventListener('change', e => {
    filterType = e.target.value;
});
document.getElementById('btnReset').addEventListener('click', () => {
    ox = 0; oy = 0; scale = 1;
});

window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'graphData') {
        status.style.display = 'none';
        const idMap = {};
        nodes = msg.nodes.map((n, i) => {
            idMap[n.id] = i;
            return { ...n, x: (Math.random()-0.5)*300, y: (Math.random()-0.5)*300, vx:0, vy:0 };
        });
        edges = msg.edges.filter(e => idMap[e.src] !== undefined && idMap[e.tgt] !== undefined)
            .map(e => ({ ...e, srcIdx: idMap[e.src], tgtIdx: idMap[e.tgt] }));
        info.textContent = nodes.length + ' nodes, ' + edges.length + ' edges';
    }
    if (msg.command === 'error') {
        status.textContent = 'Error: ' + msg.message;
        status.style.display = 'block';
    }
});

vscode.postMessage({ command: 'fetchGraph' });
loop();
</script>
</body>
</html>`;
    }
}
