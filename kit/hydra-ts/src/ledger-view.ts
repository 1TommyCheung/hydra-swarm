import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authDir, ledger, log, runDir, yamlScalar } from './lib.ts';

/**
 * Escape text for safe inclusion in HTML. Mirrors jq's @html filter:
 * encodes &, <, >, and " as entities.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface LedgerEntry {
  event?: string;
  time?: string;
  run_id?: string;
  [key: string]: unknown;
}

function jqInterpolate(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

function buildDetail(entry: LedgerEntry): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'event' || key === 'time' || key === 'run_id') continue;
    parts.push(`${key}=${jqInterpolate(value)}`);
  }
  return parts.join('  ');
}

function buildRow(entry: LedgerEntry): string {
  const event = jqInterpolate(entry.event ?? null);
  const time = entry.time === null || entry.time === undefined || entry.time === false
    ? ''
    : jqInterpolate(entry.time);
  const detail = escapeHtml(buildDetail(entry));
  return `<tr class="ev-${event}"><td class="t">${time}</td><td class="e">${event}</td><td class="d">${detail}</td></tr>`;
}

/**
 * Render the authoritative ledger view for a run.
 *
 * @param runId   The run identifier.
 * @param outPath Optional output path; defaults to <authDir(runId)>/ledger-view.html.
 * @returns The path to the written HTML file.
 */
export function renderLedgerView(runId: string, outPath?: string): string {
  const ledgerPath = ledger(runId);
  if (!existsSync(ledgerPath)) {
    throw new Error(`hydra: error: no ledger for run ${runId}`);
  }

  const outputPath = outPath ?? join(authDir(runId), 'ledger-view.html');

  const lines = readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');

  const rows: string[] = [];
  let nPromoted = 0;
  let nRejected = 0;

  for (const line of lines) {
    if (line.includes('"result_promoted"')) nPromoted += 1;
    if (line.includes('"result_rejected"')) nRejected += 1;

    const entry: LedgerEntry = JSON.parse(line) as LedgerEntry;
    rows.push(buildRow(entry));
  }

  const nEvents = lines.length;
  let base: string;
  try {
    base = yamlScalar(join(runDir(runId), 'run.yaml'), 'base_commit');
  } catch {
    base = '?';
  }

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Hydra-Swarm run ${escapeHtml(runId)} — authoritative ledger</title>
<style>
 body{font:13px/1.5 ui-monospace,Menlo,monospace;background:#111;color:#ddd;margin:0;padding:24px}
 h1{font-size:16px;color:#fff;margin:0 0 4px} .sub{color:#888;margin:0 0 16px}
 .stats{display:flex;gap:16px;margin:0 0 16px;flex-wrap:wrap}
 .stat{background:#1c1c1c;border:1px solid #333;border-radius:6px;padding:8px 14px}
 .stat b{color:#fff;font-size:18px;display:block}
 table{border-collapse:collapse;width:100%;max-width:100%}
 td{padding:5px 8px;border-bottom:1px solid #222;vertical-align:top}
 .t{color:#6aa;white-space:nowrap} .e{font-weight:700;white-space:nowrap} .d{color:#aaa;word-break:break-all}
 tr.ev-result_promoted .e{color:#4ade80} tr.ev-result_rejected .e{color:#f87171}
 tr.ev-review_verdict .e{color:#c084fc} tr.ev-graph_impact .e,tr.ev-graphify_investigation .e{color:#fbbf24}
 tr.ev-agent_usage .e{color:#60a5fa} tr.ev-combined_verification .e{color:#4ade80}
 tr.ev-task_spec_amended .e{color:#fb923c}
</style></head><body>
<h1>Hydra-Swarm — run ${escapeHtml(runId)}</h1>
<p class="sub">Authoritative Layer-2 view · base ${escapeHtml(base)} · rendered from the append-only ledger only</p>
<div class="stats">
 <div class="stat"><b>${nEvents}</b>events</div>
 <div class="stat"><b>${nPromoted}</b>promoted</div>
 <div class="stat"><b>${nRejected}</b>rejected</div>
</div>
<table>${rows.join('')}</table>
<p class="note">Live state (herdr/panes) is advisory; Git + ledger win. This page
never scrapes worker output as truth. A disagreement between live state and this
view is itself an anomaly event.</p>
</body></html>`;

  writeFileSync(outputPath, html, 'utf8');
  log(`authoritative ledger view -> ${outputPath} (${nEvents} events)`);
  process.stdout.write(`${outputPath}\n`);
  return outputPath;
}

export default {
  renderLedgerView,
  escapeHtml,
};
