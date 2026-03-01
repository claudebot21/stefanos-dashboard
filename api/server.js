const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const DATA_DIR = path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function execCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err && !stdout) reject(err);
            else resolve(stdout.trim());
        });
    });
}

async function getCPU() {
    try {
        const s1 = await execCommand("cat /proc/stat | grep '^cpu ' | awk '{print ($2+$3+$4+$5+$6+$7+$8, $5)}'");
        await new Promise(r => setTimeout(r, 1000));
        const s2 = await execCommand("cat /proc/stat | grep '^cpu ' | awk '{print ($2+$3+$4+$5+$6+$7+$8, $5)}'");
        const [t1, i1] = s1.split(' ').map(Number), [t2, i2] = s2.split(' ').map(Number);
        const td = t2 - t1, id = i2 - i1;
        const usage = ((td - id) / td * 100).toFixed(1);
        return { usage: parseFloat(usage), cores: require('os').cpus().length };
    } catch (e) { return { usage: 0, cores: 1 }; }
}

async function getMemory() {
    try {
        const m = await execCommand("free -b | grep Mem | awk '{print $2, $3, $7}'");
        const [t, u, a] = m.split(' ').map(Number);
        return { total: t, used: u, available: a, percentage: ((u / t) * 100).toFixed(1) };
    } catch (e) {
        const t = require('os').totalmem(), f = require('os').freemem();
        return { total: t, used: t - f, available: f, percentage: (((t - f) / t) * 100).toFixed(1) };
    }
}

async function getDisk() {
    try {
        const d = await execCommand("df -B1 / | tail -1 | awk '{print $2, $3, $4}'");
        const [t, u, a] = d.split(' ').map(Number);
        return { total: t, used: u, available: a, percentage: ((u / t) * 100).toFixed(1) };
    } catch (e) { return { total: 0, used: 0, available: 0, percentage: 0 }; }
}

async function getLoad() {
    try {
        const l = await execCommand("cat /proc/loadavg");
        const [one, five, fifteen] = l.split(' ').map(Number);
        const c = require('os').cpus().length;
        return { one, five, fifteen, cores: c, percentage: ((one / c) * 100).toFixed(1) };
    } catch (e) { const [o, f, ft] = require('os').loadavg(); return { one: o, five: f, fifteen: ft, cores: 1, percentage: (o * 100).toFixed(1) }; }
}

async function getUptime() {
    try {
        const u = await execCommand("cat /proc/uptime | awk '{print $1}'");
        const s = parseFloat(u), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        return { seconds: s, days: d, hours: h, mins: m, formatted: `${d}d ${h}h ${m}m` };
    } catch (e) { return { seconds: 0, days: 0, hours: 0, mins: 0, formatted: 'Unknown' }; }
}

async function getNetwork() {
    try {
        const n = await execCommand("cat /proc/net/dev | grep -E 'eth|ens|enp|wlan|wlp' | head -1");
        const p = n.trim().split(/\s+/);
        if (p.length >= 9) {
            const rx = parseInt(p[1]) || 0, tx = parseInt(p[9]) || 0;
            return { rx, tx, rxFormatted: formatBytes(rx), txFormatted: formatBytes(tx) };
        }
        return { rx: 0, tx: 0, rxFormatted: '0 B', txFormatted: '0 B' };
    } catch (e) { return { rx: 0, tx: 0, rxFormatted: '0 B', txFormatted: '0 B' }; }
}

async function getProcesses() {
    try {
        const p = await execCommand("ps aux --sort=-%cpu | head -6 | tail -5 | awk '{print $11, $3, $4}'");
        return p.split('\n').map(l => { const ps = l.trim().split(/\s+/); return { name: ps[0].split('/').pop() || ps[0], cpu: ps[1] || '0', mem: ps[2] || '0' }; });
    } catch (e) { return []; }
}

function formatBytes(b) {
    if (b === 0) return '0 B';
    const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + s[i];
}

async function getAllMetrics() {
    const [cpu, memory, disk, load, uptime, network, processes] = await Promise.all([getCPU(), getMemory(), getDisk(), getLoad(), getUptime(), getNetwork(), getProcesses()]);
    return { timestamp: new Date().toISOString(), cpu, memory, disk, load, uptime, network, processes, hostname: require('os').hostname(), platform: require('os').platform() };
}

const MAX_HISTORY = 60;
let metricsHistory = [];

async function updateHistory() {
    try {
        const m = await getAllMetrics();
        metricsHistory.push(m);
        if (metricsHistory.length > MAX_HISTORY) metricsHistory.shift();
        fs.writeFileSync(path.join(DATA_DIR, 'metrics.json'), JSON.stringify(metricsHistory, null, 2));
    } catch (e) { console.error('History update failed:', e.message); }
}

setInterval(updateHistory, 30000);
updateHistory();

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
        switch (url.pathname) {
            case '/api/metrics': res.writeHead(200); res.end(JSON.stringify(await getAllMetrics())); break;
            case '/api/history': res.writeHead(200); res.end(JSON.stringify(metricsHistory)); break;
            case '/api/health': res.writeHead(200); res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() })); break;
            default: res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
        }
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
});

server.listen(PORT, () => {
    console.log(`StefanOS Metrics API on port ${PORT}`);
    console.log(`  GET /api/metrics  - Current metrics`);
    console.log(`  GET /api/history  - History (${MAX_HISTORY} samples)`);
    console.log(`  GET /api/health   - Health check`);
});
