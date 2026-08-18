// Extension host glue: diagnostics, the manifest tree, document links, the URL
// fetcher and the segcheck deep check.
//
// Everything that decides anything lives in src/core (pure, tested). This file
// translates between that model and the editor, and is deliberately thin.
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

import { analyze, applySeverityOverrides, Finding, RULES, Severity } from './core/analyze';
import { buildLadder, LadderRow, ladderSummary, lowLatencyRows, renditionRows } from './core/ladder';
import { parsePlaylist, Playlist, looksLikePlaylist } from './core/playlist';
import { buildSegcheckArgs, parseSegcheckResult, segcheckSummary, segcheckToFindings } from './core/segcheck';
import { fetchText } from './core/fetch';
import { completeAt, renderTagHover, tagSpec } from './core/spec';
import { quickFixesFor } from './core/fixes';
import { analyzeAcross, LoadedRendition } from './core/crosscheck';
import { describeChange, diffPlaylists, watchIntervalMs } from './core/watch';
import { analyzeMpd } from './core/dash';
import { buildMpdTree, mpdSummary, MpdRow } from './core/mpdtree';
import { isManifestPath, renderWorkspaceReport, summariseWorkspace, WorkspaceEntry } from './core/workspace';
import { renderFindingsJson, renderFindingsMarkdown } from './core/report';
import { compareManifests, compareMpds, describeComparison } from './core/compare';
import { profileOverrides } from './core/profiles';
import { buildTimeline, renderTimelineHtml, TimelineTrack } from './core/timeline';
import { isRemote, looksLikePlaylistUri, resolveUri } from './core/uri';

/** Scheme of the read-only documents holding manifests fetched from a URL. */
const SCHEME = 'hls-lens';

/** Contents of the fetched manifests, keyed by virtual document URI. */
const fetched = new Map<string, string>();

let diagnostics: vscode.DiagnosticCollection;
let deepDiagnostics: vscode.DiagnosticCollection;
let crossDiagnostics: vscode.DiagnosticCollection;
let workspaceDiagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let tree: ManifestTreeProvider;

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection('hls-lens');
  deepDiagnostics = vscode.languages.createDiagnosticCollection('hls-lens-segcheck');
  // Its own collection, like segcheck's: these findings cost a round of network or disk
  // reads, and the manifest collection is rewritten on every keystroke.
  crossDiagnostics = vscode.languages.createDiagnosticCollection('hls-lens-cross');
  workspaceDiagnostics = vscode.languages.createDiagnosticCollection('hls-lens-workspace');
  output = vscode.window.createOutputChannel('HLS Lens');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  tree = new ManifestTreeProvider();

  context.subscriptions.push(
    diagnostics,
    deepDiagnostics,
    crossDiagnostics,
    workspaceDiagnostics,
    output,
    statusBar,
    vscode.window.registerTreeDataProvider('hlsLens.explorer', tree),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => fetched.get(uri.toString()) ?? '',
    }),
    vscode.languages.registerDocumentLinkProvider({ language: 'm3u8' }, new PlaylistLinkProvider()),
    vscode.languages.registerHoverProvider({ language: 'm3u8' }, new TagHoverProvider()),
    // '#' opens the tag list, ':' and ',' the attributes, '=' the enumerated values:
    // the three characters after which the spec has something specific to offer.
    vscode.languages.registerCompletionItemProvider({ language: 'm3u8' }, new TagCompletionProvider(), '#', ':', ',', '='),
    vscode.languages.registerCodeActionsProvider({ language: 'm3u8' }, new PlaylistFixProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
  );

  // Diagnostics and the tree follow whatever manifest is in front of the user.
  const refresh = (doc?: vscode.TextDocument): void => {
    if (doc) updateDiagnostics(doc);
    tree.refresh();
    updateStatusBar();
  };
  let debounce: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      deepDiagnostics.delete(doc.uri);
      crossDiagnostics.delete(doc.uri);
      fetched.delete(doc.uri.toString());
      refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      // MPDs are edited too: without them here an .mpd only refreshed on save.
      if (!isPlaylistDocument(event.document) && !isMpdDocument(event.document)) return;
      if (debounce) clearTimeout(debounce);
      // Analysis is cheap, but re-running it on every keystroke makes the squiggles
      // flicker while a line is half-typed.
      debounce = setTimeout(() => refresh(event.document), 300);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => refresh(editor?.document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('hlsLens')) return;
      for (const doc of vscode.workspace.textDocuments) updateDiagnostics(doc);
      refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hlsLens.refresh', () => refresh(vscode.window.activeTextEditor?.document)),
    vscode.commands.registerCommand('hlsLens.openUrl', () => openManifestUrl()),
    vscode.commands.registerCommand('hlsLens.openChild', (node?: TreeNode) => openChild(node)),
    vscode.commands.registerCommand('hlsLens.copyUri', (node?: TreeNode) => copyUri(node)),
    vscode.commands.registerCommand('hlsLens.revealLine', (line: number) => revealLine(line)),
    vscode.commands.registerCommand('hlsLens.deepCheck', () => deepCheck()),
    vscode.commands.registerCommand('hlsLens.showRules', () => showRules()),
    vscode.commands.registerCommand('hlsLens.checkTogether', () => checkTogether()),
    vscode.commands.registerCommand('hlsLens.deepCheckVariant', (node?: TreeNode) => deepCheckVariant(node)),
    vscode.commands.registerCommand('hlsLens.watch', () => toggleWatch()),
    vscode.commands.registerCommand('hlsLens.showTimeline', () => showTimeline()),
    vscode.commands.registerCommand('hlsLens.checkWorkspace', () => checkWorkspace()),
    vscode.commands.registerCommand('hlsLens.exportReport', () => exportReport()),
    vscode.commands.registerCommand('hlsLens.compareWith', () => compareWith()),
  );

  for (const doc of vscode.workspace.textDocuments) updateDiagnostics(doc);
  refresh(vscode.window.activeTextEditor?.document);
}

export function deactivate(): void {
  fetched.clear();
}

// ---------------------------------------------------------------- diagnostics

function isPlaylistDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'm3u8' || looksLikePlaylist(doc.getText().slice(0, 64));
}

/** An .mpd, or an XML document whose root is an MPD saved under another name. */
function isMpdDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'dash-mpd' || /<MPD[\s>]/.test(doc.getText().slice(0, 2048));
}

function severityToVsCode(severity: Severity): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    // A vscode Hint is only visible when the cursor is on the line, which would
    // hide the advisory rules entirely; Information keeps them in the panel.
    case 'hint':
      return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * Findings as the user's settings want them graded. Applied before the minSeverity
 * floor, so a hint promoted to an error is visible even with the floor raised.
 */
function graded(findings: Finding[]): Finding[] {
  const config = vscode.workspace.getConfiguration('hlsLens');
  // The profile is a starting point and the user's own settings are the last word,
  // so they go on top of it rather than under it.
  const overrides = {
    ...profileOverrides(config.get<string>('diagnostics.profile', 'none')),
    ...config.get<Record<string, string>>('diagnostics.severity', {}),
  };
  return applySeverityOverrides(findings, overrides);
}

function updateDiagnostics(doc: vscode.TextDocument): void {
  const config = vscode.workspace.getConfiguration('hlsLens');
  if (isMpdDocument(doc) && !isPlaylistDocument(doc)) {
    if (!config.get<boolean>('diagnostics.enabled', true)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const skip = config.get<string[]>('diagnostics.skip', []);
    const floor = config.get<Severity>('diagnostics.minSeverity', 'hint');
    const rank: Record<Severity, number> = { error: 0, warning: 1, hint: 2 };
    const found = graded(analyzeMpd(doc.getText()).filter((f) => !skip.includes(f.rule) && !skip.includes(f.rule.split('/')[0]))).filter(
      (f) => rank[f.severity] <= rank[floor],
    );
    diagnostics.set(doc.uri, found.map((f) => toDiagnostic(doc, f)));
    return;
  }
  if (!isPlaylistDocument(doc)) return;
  if (!config.get<boolean>('diagnostics.enabled', true)) {
    diagnostics.delete(doc.uri);
    return;
  }
  // Once a manifest is open its own diagnostics are live and authoritative: drop
  // whatever the workspace scan left on it, or the Problems panel shows each finding
  // twice.
  workspaceDiagnostics.delete(doc.uri);
  const playlist = parsePlaylist(doc.getText());
  const findings = analyze(playlist, {
    pdtDriftToleranceMs: config.get<number>('pdtDriftToleranceMs', 500),
    targetDurationSlack: config.get<number>('targetDurationSlack', 1.5),
    skip: config.get<string[]>('diagnostics.skip', []),
  });
  const floor = config.get<Severity>('diagnostics.minSeverity', 'hint');
  const rank: Record<Severity, number> = { error: 0, warning: 1, hint: 2 };
  diagnostics.set(
    doc.uri,
    graded(findings)
      .filter((f) => rank[f.severity] <= rank[floor])
      .map((f) => toDiagnostic(doc, f)),
  );
}

function toDiagnostic(doc: vscode.TextDocument, finding: Finding): vscode.Diagnostic {
  const line = Math.min(finding.line, Math.max(doc.lineCount - 1, 0));
  const text = doc.lineAt(line);
  // Underline the text, not the indentation: a squiggle over an empty range is
  // invisible, which is how a finding gets reported and never seen.
  const range = text.text.trim().length > 0 ? text.range : new vscode.Range(line, 0, line, 1);
  const message = finding.hint ? `${finding.message}\n→ ${finding.hint}` : finding.message;
  const diagnostic = new vscode.Diagnostic(range, message, severityToVsCode(finding.severity));
  diagnostic.source = 'hls-lens';
  diagnostic.code = finding.rule;
  return diagnostic;
}

// ------------------------------------------------------------- active manifest

interface ActiveManifest {
  doc: vscode.TextDocument;
  playlist: Playlist;
  /** Where the manifest lives: an http(s) URL, or a filesystem path. */
  location: string;
  findings: Finding[];
}

/** locationOf returns what relative URIs in a document resolve against. */
function locationOf(doc: vscode.TextDocument): string {
  if (doc.uri.scheme === SCHEME) {
    const url = new URLSearchParams(doc.uri.query).get('url');
    if (url) return url;
  }
  return doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.uri.toString();
}

function activeManifest(): ActiveManifest | undefined {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc || !isPlaylistDocument(doc)) return undefined;
  const config = vscode.workspace.getConfiguration('hlsLens');
  const playlist = parsePlaylist(doc.getText());
  return {
    doc,
    playlist,
    location: locationOf(doc),
    findings: graded(
      analyze(playlist, {
        pdtDriftToleranceMs: config.get<number>('pdtDriftToleranceMs', 500),
        targetDurationSlack: config.get<number>('targetDurationSlack', 1.5),
        skip: config.get<string[]>('diagnostics.skip', []),
      }),
    ),
  };
}

function updateStatusBar(): void {
  const active = activeManifest();
  if (!active || active.playlist.kind === 'unknown') {
    const mpd = activeMpdDocument();
    if (!mpd) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(list-tree) ${mpdSummary(mpd.getText())}`;
    statusBar.tooltip = 'HLS Lens — click to open the manifest tree';
    statusBar.command = 'hlsLens.refresh';
    statusBar.show();
    return;
  }
  // While the watch runs, the status bar is where it lives: a poller with no visible
  // state is a poller nobody remembers is running.
  const watch = watching ? `$(eye) watching${watching.stalls > 0 ? ` · stalled ×${watching.stalls}` : ''} · ` : '';
  statusBar.text = `${watch}$(list-tree) ${ladderSummary(active.playlist)}`;
  statusBar.tooltip = watching ? 'HLS Lens — click to stop watching the playlist' : 'HLS Lens — click to open the manifest tree';
  statusBar.command = watching ? 'hlsLens.watch' : 'hlsLens.refresh';
  statusBar.show();
}

// -------------------------------------------------------------------- tree

type NodeKind = 'section' | 'row' | 'finding' | 'info';

class TreeNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NodeKind,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children: TreeNode[] = [],
    /** Manifest-relative URI this node points at, when it points at a playlist. */
    public readonly uri: string = '',
    /** Line to reveal in the manifest. */
    public readonly line: number | undefined = undefined,
  ) {
    super(label, collapsibleState);
    this.contextValue = kind === 'row' && looksLikePlaylistUri(uri) ? 'playlist' : kind;
    if (line !== undefined) {
      this.command = { command: 'hlsLens.revealLine', title: 'Reveal in manifest', arguments: [line] };
    }
  }
}

class ManifestTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) return element.children;
    const active = activeManifest();
    if (active) return buildTree(active);
    const mpd = activeMpdDocument();
    return mpd ? buildMpdNodes(mpd) : [];
  }
}

function buildTree(active: ActiveManifest): TreeNode[] {
  const { playlist, findings } = active;
  const nodes: TreeNode[] = [];
  const summary = new TreeNode(ladderSummary(playlist), 'info', vscode.TreeItemCollapsibleState.None);
  summary.description = playlist.kind;
  summary.iconPath = new vscode.ThemeIcon('list-tree');
  summary.tooltip = active.location;
  nodes.push(summary);

  const rowNode = (row: LadderRow, icon: string): TreeNode => {
    const node = new TreeNode(row.label, 'row', vscode.TreeItemCollapsibleState.None, [], row.uri, row.line);
    node.description = row.description;
    node.tooltip = new vscode.MarkdownString(row.tooltip);
    node.iconPath = new vscode.ThemeIcon(icon);
    return node;
  };

  const ladder = buildLadder(playlist);
  if (ladder.length > 0) {
    nodes.push(
      section(
        `Variants (${ladder.length})`,
        'server',
        ladder.map((row) => rowNode(row, row.iframeOnly ? 'file-media' : 'device-camera-video')),
      ),
    );
  }
  const renditions = renditionRows(playlist);
  if (renditions.length > 0) {
    nodes.push(section(`Renditions (${renditions.length})`, 'megaphone', renditions.map((row) => rowNode(row, 'unmute'))));
  }

  if (playlist.segments.length > 0) {
    // A live playlist can hold thousands of segments; the tree shows the first
    // page, and the manifest itself is one click away for the rest.
    const shown = playlist.segments.slice(0, 50);
    const children = shown.map((segment, index) => {
      const node = new TreeNode(
        `#${(playlist.mediaSequence ?? 0) + index}`,
        'row',
        vscode.TreeItemCollapsibleState.None,
        [],
        segment.uri,
        segment.uriLine,
      );
      const marks = [segment.discontinuity ? 'DISCONTINUITY' : '', segment.gap ? 'GAP' : '', segment.byterange ? `@${segment.byterange}` : '']
        .filter((s) => s.length > 0)
        .join(' · ');
      node.description = `${segment.duration ?? '?'}s  ${segment.uri}${marks ? '  · ' + marks : ''}`;
      node.iconPath = new vscode.ThemeIcon(segment.gap ? 'circle-slash' : 'symbol-event');
      return node;
    });
    if (playlist.segments.length > shown.length) {
      children.push(new TreeNode(`… ${playlist.segments.length - shown.length} more`, 'info', vscode.TreeItemCollapsibleState.None));
    }
    nodes.push(section(`Segments (${playlist.segments.length})`, 'symbol-event', children));
  }

  if (playlist.maps.length > 0 || playlist.keys.length > 0) {
    const children: TreeNode[] = [];
    for (const map of playlist.maps) {
      const node = new TreeNode('EXT-X-MAP', 'row', vscode.TreeItemCollapsibleState.None, [], map.attrs.get('URI') ?? '', map.line);
      node.description = map.attrs.get('URI') ?? '';
      node.iconPath = new vscode.ThemeIcon('file-binary');
      children.push(node);
    }
    for (const key of playlist.keys) {
      const node = new TreeNode(`${key.name} ${key.attrs.get('METHOD') ?? ''}`.trim(), 'row', vscode.TreeItemCollapsibleState.None, [], '', key.line);
      node.description = key.attrs.get('URI') ?? '';
      node.iconPath = new vscode.ThemeIcon('key');
      children.push(node);
    }
    nodes.push(section(`Init & keys (${children.length})`, 'key', children));
  }

  const lowLatency = lowLatencyRows(playlist);
  if (lowLatency.length > 0) {
    const icons: Record<string, string> = {
      'server-control': 'settings',
      part: 'symbol-ruler',
      'preload-hint': 'rocket',
      'rendition-report': 'broadcast',
      note: 'ellipsis',
    };
    nodes.push(
      section(
        `Low latency (${playlist.parts.length} parts)`,
        'zap',
        lowLatency.map((row) => {
          const node = new TreeNode(row.label, 'row', vscode.TreeItemCollapsibleState.None, [], '', row.line >= 0 ? row.line : undefined);
          node.description = row.description;
          node.iconPath = new vscode.ThemeIcon(icons[row.kind] ?? 'circle-small');
          return node;
        }),
      ),
    );
  }

  if (findings.length > 0) nodes.push(problemsSection(findings));

  return nodes;
}

/** The findings as a section, the same in the playlist tree and the MPD one. */
function problemsSection(findings: Finding[]): TreeNode {
  const children = findings.map((finding) => {
    const node = new TreeNode(finding.rule, 'finding', vscode.TreeItemCollapsibleState.None, [], '', finding.line);
    node.description = `line ${finding.line + 1} · ${finding.message}`;
    node.tooltip = new vscode.MarkdownString(`**${finding.rule}**\n\n${finding.message}${finding.hint ? `\n\n→ ${finding.hint}` : ''}`);
    node.iconPath = new vscode.ThemeIcon(finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warning' : 'info');
    return node;
  });
  return section(`Problems (${findings.length})`, 'warning', children, vscode.TreeItemCollapsibleState.Expanded);
}

/**
 * The MPD as a tree. DASH manifests have had diagnostics since v0.8.0 and no shape:
 * the ladder is in the file, nested four elements deep and spread across attributes,
 * which is exactly the reading this extension exists to do for you.
 */
function buildMpdNodes(doc: vscode.TextDocument): TreeNode[] {
  const text = doc.getText();
  const nodes: TreeNode[] = [];
  const summary = new TreeNode(mpdSummary(text), 'info', vscode.TreeItemCollapsibleState.None);
  summary.description = 'DASH';
  summary.iconPath = new vscode.ThemeIcon('list-tree');
  summary.tooltip = locationOf(doc);
  nodes.push(summary);

  const icons: Record<MpdRow['kind'], string> = { period: 'symbol-namespace', adaptation: 'server', representation: 'device-camera-video' };
  const toNode = (row: MpdRow): TreeNode => {
    const node = new TreeNode(
      row.label,
      row.children.length > 0 ? 'section' : 'row',
      row.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      row.children.map(toNode),
      '',
      row.line,
    );
    node.description = row.description;
    node.tooltip = new vscode.MarkdownString(row.tooltip);
    node.iconPath = new vscode.ThemeIcon(icons[row.kind]);
    return node;
  };
  nodes.push(...buildMpdTree(text).map(toNode));

  const config = vscode.workspace.getConfiguration('hlsLens');
  const skip = config.get<string[]>('diagnostics.skip', []);
  const findings = graded(analyzeMpd(text).filter((f) => !skip.includes(f.rule) && !skip.includes(f.rule.split('/')[0])));
  if (findings.length > 0) nodes.push(problemsSection(findings));
  return nodes;
}

/** The active editor when it holds an MPD (and not a playlist). */
function activeMpdDocument(): vscode.TextDocument | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  return doc && isMpdDocument(doc) && !isPlaylistDocument(doc) ? doc : undefined;
}

function section(
  label: string,
  icon: string,
  children: TreeNode[],
  state = vscode.TreeItemCollapsibleState.Collapsed,
): TreeNode {
  const node = new TreeNode(label, 'section', children.length > 0 ? state : vscode.TreeItemCollapsibleState.None, children);
  node.iconPath = new vscode.ThemeIcon(icon);
  return node;
}

// ----------------------------------------------------------------- commands

async function revealLine(line: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const target = Math.min(Math.max(line, 0), Math.max(editor.document.lineCount - 1, 0));
  const range = editor.document.lineAt(target).range;
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  editor.selection = new vscode.Selection(range.start, range.start);
}

async function openManifestUrl(url?: string): Promise<void> {
  const target =
    url ??
    (await vscode.window.showInputBox({
      title: 'Open HLS manifest',
      prompt: 'URL of a master or media playlist',
      placeHolder: 'https://cdn.example.com/hls/master.m3u8',
      validateInput: (value) => (isRemote(value.trim()) ? undefined : 'Enter an http(s) URL'),
    }));
  if (!target) return;

  const config = vscode.workspace.getConfiguration('hlsLens');
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `HLS Lens: fetching ${target}` },
      () =>
        fetchText(target.trim(), {
          headers: config.get<Record<string, string>>('request.headers', {}),
          timeoutMs: config.get<number>('request.timeoutMs', 15000),
        }),
    );
    await showFetchedManifest(result.finalUrl, result.text);
  } catch (err) {
    void vscode.window.showErrorMessage(`HLS Lens: ${(err as Error).message}`);
  }
}

/**
 * showFetchedManifest opens fetched content as a read-only document.
 *
 * The source URL is carried in the virtual URI's query, so resolving a child
 * playlist after a redirect works without any state that can go stale — and the
 * path keeps the .m3u8 extension so the m3u8 language, and with it the diagnostics,
 * apply to it.
 */
async function showFetchedManifest(sourceUrl: string, text: string): Promise<void> {
  const parsed = new URL(sourceUrl);
  const uri = vscode.Uri.parse(`${SCHEME}:${parsed.host}${parsed.pathname}`).with({
    query: new URLSearchParams({ url: sourceUrl }).toString(),
  });
  fetched.set(uri.toString(), text);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, 'm3u8');
  await vscode.window.showTextDocument(doc, { preview: false });
  updateDiagnostics(doc);
  tree.refresh();
  updateStatusBar();
}

async function openChild(node?: TreeNode): Promise<void> {
  const active = activeManifest();
  if (!active || !node?.uri) {
    void vscode.window.showInformationMessage('HLS Lens: nothing to open — pick a variant or a rendition in the tree.');
    return;
  }
  const resolved = resolveUri(active.location, node.uri);
  if (isRemote(resolved)) {
    await openManifestUrl(resolved);
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    void vscode.window.showErrorMessage(`HLS Lens: cannot open ${resolved} — ${(err as Error).message}`);
  }
}

async function copyUri(node?: TreeNode): Promise<void> {
  const active = activeManifest();
  if (!active || !node?.uri) return;
  const resolved = resolveUri(active.location, node.uri);
  await vscode.env.clipboard.writeText(resolved);
  void vscode.window.showInformationMessage(`HLS Lens: copied ${resolved}`);
}

async function showRules(): Promise<void> {
  const lines = [`# HLS Lens rules (${RULES.length})`, ''];
  for (const scope of ['syntax', 'master', 'media'] as const) {
    lines.push(`## ${scope}`, '');
    for (const rule of RULES.filter((r) => r.scope === scope)) {
      lines.push(`### \`${rule.id}\` — ${rule.severity}`, '', `**${rule.title}**`, '', rule.rationale, '');
    }
  }
  const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
  await vscode.commands.executeCommand('markdown.showPreview');
}

/**
 * deepCheck runs segcheck against the manifest URL and brings its findings back.
 *
 * Only a URL can be deep-checked: the segments live next to the manifest on the
 * CDN, so a playlist open from disk is asked for its origin rather than guessed at.
 */
async function deepCheck(preset?: string): Promise<void> {
  const active = activeManifest();
  const suggested = active && isRemote(active.location) ? active.location : '';
  // A preset URL comes from the tree: the rendition the user picked, already resolved.
  const url = preset ?? (await vscode.window.showInputBox({
    title: 'Deep check with segcheck',
    prompt: 'Manifest URL to download and inspect',
    value: suggested,
    placeHolder: 'https://cdn.example.com/hls/master.m3u8',
    validateInput: (value) => (isRemote(value.trim()) ? undefined : 'segcheck downloads segments, so it needs an http(s) URL'),
  }));
  if (!url) return;
  if (!isRemote(url)) {
    void vscode.window.showWarningMessage('HLS Lens: segcheck downloads segments, so it needs an http(s) URL.');
    return;
  }

  const config = vscode.workspace.getConfiguration('hlsLens');
  const bin = config.get<string>('segcheck.path', 'segcheck');
  const args = buildSegcheckArgs(url.trim(), {
    segments: config.get<number>('segcheck.segments', 6),
    renditions: config.get<number>('segcheck.renditions', 0),
    from: config.get<'auto' | 'edge' | 'start'>('segcheck.from', 'auto'),
    insecure: config.get<boolean>('segcheck.insecure', false),
    headers: config.get<Record<string, string>>('request.headers', {}),
  });

  output.appendLine(`$ ${bin} ${args.join(' ')}`);
  try {
    const stdout = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'HLS Lens: downloading and parsing segments…', cancellable: true },
      (_progress, token) => runSegcheck(bin, args, token),
    );
    const result = parseSegcheckResult(stdout);
    const summary = segcheckSummary(result);
    output.appendLine(summary);
    for (const finding of result.findings) {
      output.appendLine(`${finding.status.padEnd(5)} ${finding.check.padEnd(12)} ${finding.target}  ${finding.message}`);
    }

    const doc = active?.doc ?? vscode.window.activeTextEditor?.document;
    if (doc) {
      deepDiagnostics.set(
        doc.uri,
        segcheckToFindings(result).map((finding) => toDiagnostic(doc, finding)),
      );
    }
    const action = await vscode.window.showInformationMessage(`segcheck: ${summary}`, 'Show output');
    if (action === 'Show output') output.show(true);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('ENOENT')) {
      const action = await vscode.window.showErrorMessage(
        `HLS Lens: ${bin} not found. The deep check needs the segcheck binary.`,
        'Install instructions',
      );
      if (action === 'Install instructions') {
        await vscode.env.openExternal(vscode.Uri.parse('https://github.com/Allan-Nava/segcheck#install'));
      }
      return;
    }
    output.appendLine(`error: ${message}`);
    void vscode.window.showErrorMessage(`HLS Lens: ${message}`);
  }
}

function runSegcheck(bin: string, args: string[], token: vscode.CancellationToken): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (err) => reject(new Error(`${err.message} (${(err as NodeJS.ErrnoException).code ?? 'spawn failed'})`)));
    child.on('close', (code) => {
      // segcheck exits 0 whenever the check ran, findings or not, so a non-zero
      // exit with no JSON on stdout is a real failure worth surfacing.
      if (stdout.includes('{')) resolve(stdout);
      else reject(new Error(stderr.trim() || `segcheck exited with code ${code}`));
    });
    token.onCancellationRequested(() => child.kill());
  });
}

// ------------------------------------------------------------- document links

/**
 * PlaylistLinkProvider turns the URI lines of a playlist into links: a child
 * playlist next to a manifest on disk opens in the editor, a remote one opens
 * where it lives.
 */
class PlaylistLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    if (!isPlaylistDocument(doc)) return [];
    const playlist = parsePlaylist(doc.getText());
    const location = locationOf(doc);
    const links: vscode.DocumentLink[] = [];

    const add = (line: number, ref: string): void => {
      if (!ref) return;
      const resolved = resolveUri(location, ref);
      const text = doc.lineAt(Math.min(line, Math.max(doc.lineCount - 1, 0)));
      const start = text.text.indexOf(ref);
      if (start === -1) return;
      const range = new vscode.Range(line, start, line, start + ref.length);
      try {
        const target = isRemote(resolved) ? vscode.Uri.parse(resolved) : vscode.Uri.file(resolved);
        const link = new vscode.DocumentLink(range, target);
        link.tooltip = resolved;
        links.push(link);
      } catch {
        // An unparsable URI is a finding, not a crash: the rules report it.
      }
    };

    for (const variant of playlist.variants) add(variant.uriLine, variant.uri);
    for (const rendition of playlist.renditions) if (rendition.uri) add(rendition.line, rendition.uri);
    for (const map of playlist.maps) {
      const uri = map.attrs.get('URI');
      if (uri) add(map.line, uri);
    }
    for (const segment of playlist.segments) add(segment.uriLine, segment.uri);
    return links;
  }
}

/** Hover: the spec entry for the tag under the cursor. */
class TagHoverProvider implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const line = doc.lineAt(position.line).text;
    if (!line.startsWith('#')) return undefined;
    const end = line.indexOf(':');
    const name = line.slice(1, end < 0 ? undefined : end);
    // Only over the tag name itself, so hovering a URI or an attribute value is quiet.
    if (position.character > name.length + 1) return undefined;
    const markdown = renderTagHover(name);
    if (!markdown) return undefined;
    return new vscode.Hover(new vscode.MarkdownString(markdown), new vscode.Range(position.line, 1, position.line, name.length + 1));
  }
}

/** Completion: tag names, attribute names, and the enumerated values of an attribute. */
class TagCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const playlist = parsePlaylist(doc.getText());
    const kind = playlist.kind === 'master' || playlist.kind === 'media' ? playlist.kind : 'unknown';
    const { kind: what, items } = completeAt(doc.lineAt(position.line).text, position.character, kind);
    return items.map((label) => {
      const item = new vscode.CompletionItem(
        label,
        what === 'tag' ? vscode.CompletionItemKind.Keyword : what === 'attribute' ? vscode.CompletionItemKind.Property : vscode.CompletionItemKind.EnumMember,
      );
      if (what === 'tag') {
        const spec = tagSpec(label);
        if (spec) {
          item.detail = `since version ${spec.since}`;
          item.documentation = new vscode.MarkdownString(spec.summary);
        }
      }
      return item;
    });
  }
}

/** Code actions: the quick fixes for the findings an edit can settle. */
class PlaylistFixProvider implements vscode.CodeActionProvider {
  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const playlist = parsePlaylist(doc.getText());
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      // 'hls-lens' is what updateDiagnostics stamps; segcheck findings live in the
      // other collection and are not fixable from the manifest anyway.
      if (diagnostic.source !== 'hls-lens' || typeof diagnostic.code !== 'string') continue;
      const finding: Finding = {
        rule: diagnostic.code,
        // The fixes read the rule id and the message; the severity is only here
        // because a Finding has one.
        severity: 'warning',
        line: diagnostic.range.start.line,
        message: diagnostic.message,
      };
      for (const fix of quickFixesFor(playlist, finding)) {
        const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.edit = new vscode.WorkspaceEdit();
        if (fix.edit.kind === 'replace') {
          action.edit.replace(doc.uri, doc.lineAt(fix.edit.line).range, fix.edit.text);
        } else {
          action.edit.insert(doc.uri, doc.lineAt(fix.edit.line).range.end, `\n${fix.edit.text}`);
        }
        actions.push(action);
      }
    }
    return actions;
  }
}

/**
 * Loads the renditions of the open master and compares them with each other.
 *
 * Only the playable variants: an audio-only or subtitle rendition is legitimately
 * segmented differently, and comparing it with the video would report a defect that
 * is not one. A rendition that cannot be loaded is reported and skipped rather than
 * failing the whole check — one unreachable rung should not hide the others.
 */
async function checkTogether(): Promise<void> {
  const active = activeManifest();
  if (!active) {
    void vscode.window.showWarningMessage('HLS Lens: open a master playlist first.');
    return;
  }
  const variants = active.playlist.variants.filter((v) => !v.iframeOnly && v.uri);
  if (variants.length < 2) {
    void vscode.window.showWarningMessage('HLS Lens: this playlist has fewer than two renditions to compare.');
    return;
  }

  const config = vscode.workspace.getConfiguration('hlsLens');
  const loaded: LoadedRendition[] = [];
  const unreachable: string[] = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'HLS Lens: reading the renditions', cancellable: true },
    async (progress, token) => {
      for (const [index, variant] of variants.entries()) {
        if (token.isCancellationRequested) return;
        progress.report({ message: `${index + 1}/${variants.length} ${variant.uri}`, increment: 100 / variants.length });
        const resolved = resolveUri(active.location, variant.uri);
        try {
          const text = isRemote(resolved)
            ? (
                await fetchText(resolved, {
                  headers: config.get<Record<string, string>>('request.headers', {}),
                  timeoutMs: config.get<number>('request.timeoutMs', 15000),
                })
              ).text
            : Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved))).toString('utf8');
          loaded.push({ uri: variant.uri, line: variant.line, bandwidth: variant.bandwidth, playlist: parsePlaylist(text) });
        } catch (err) {
          unreachable.push(`${variant.uri}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  );

  // The master goes in too: cross/session-key-mismatch compares its EXT-X-SESSION-KEY
  // with the keys the renditions actually use.
  const findings = graded(analyzeAcross(loaded, { master: active.playlist }));
  const skip = config.get<string[]>('diagnostics.skip', []);
  const kept = findings.filter((f) => !skip.includes(f.rule) && !skip.includes(f.rule.split('/')[0]));
  crossDiagnostics.set(
    active.doc.uri,
    kept.map((f) => {
      // Same rendering as the manifest diagnostics, with its own source so the two
      // collections stay distinguishable in the Problems panel.
      const diagnostic = toDiagnostic(active.doc, f);
      diagnostic.source = 'hls-lens-cross';
      return diagnostic;
    }),
  );

  for (const failure of unreachable) output.appendLine(`could not read ${failure}`);
  const skipped = unreachable.length > 0 ? `, ${unreachable.length} unreachable (see the output)` : '';
  void vscode.window.showInformationMessage(
    kept.length === 0
      ? `HLS Lens: ${loaded.length} renditions agree${skipped}.`
      : `HLS Lens: ${kept.length} finding(s) across ${loaded.length} renditions${skipped}.`,
  );
}

/**
 * HL-37: this manifest against another one.
 *
 * "The packager changed something — what?" is a daily question no rule can answer,
 * because every rule judges one manifest. A text diff answers it in a form nobody can
 * read: a manifest is a set of declarations, and the interesting change is which
 * declaration moved, not which line did.
 */
async function compareWith(): Promise<void> {
  const active = activeManifest();
  const mpd = activeMpdDocument();
  if (!active && !mpd) {
    void vscode.window.showWarningMessage('HLS Lens: open a playlist or an .mpd to compare first.');
    return;
  }
  const location = active ? active.location : locationOf(mpd!);
  const other = await vscode.window.showInputBox({
    title: 'HLS Lens: compare with',
    prompt: 'Path or URL of the manifest to compare against (relative paths resolve against the open one)',
    placeHolder: '../old/master.m3u8, or https://cdn.example.com/master.m3u8',
  });
  if (!other) return;

  const resolved = resolveUri(location, other.trim());
  let text: string;
  try {
    const config = vscode.workspace.getConfiguration('hlsLens');
    text = isRemote(resolved)
      ? (
          await fetchText(resolved, {
            headers: config.get<Record<string, string>>('request.headers', {}),
            timeoutMs: config.get<number>('request.timeoutMs', 15000),
          })
        ).text
      : Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved))).toString('utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(`HLS Lens: could not read ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // The manifest that was there before is the other one; the open file is the state
  // being explained, so it is what the changes are reported against.
  const changes = active ? compareManifests(parsePlaylist(text), active.playlist) : compareMpds(text, mpd!.getText());
  output.appendLine('');
  output.appendLine(`${resolved} → ${location}`);
  for (const line of describeComparison(changes)) output.appendLine(`  ${line}`);
  output.show(true);
  void vscode.window.showInformationMessage(
    changes.length === 0
      ? 'HLS Lens: the two manifests declare the same thing.'
      : `HLS Lens: ${changes.length} difference(s) — see the output.`,
  );
}

/** The entries of the last workspace scan, so a report can be made of them. */
let lastScan: WorkspaceEntry[] | undefined;

/**
 * HL-35: the findings as a file you can send someone.
 *
 * The Problems panel is where a defect is fixed. It is not where a defect is argued
 * about with the team that produced the manifest, and a screenshot of an editor is a
 * poor attachment to a ticket.
 */
async function exportReport(): Promise<void> {
  const active = activeManifest();
  const mpd = activeMpdDocument();
  const sources: Array<vscode.QuickPickItem & { entries: WorkspaceEntry[] }> = [];
  if (active) {
    sources.push({ label: 'This manifest', description: nameOf(active.location), entries: [{ path: active.location, findings: active.findings }] });
  } else if (mpd) {
    const config = vscode.workspace.getConfiguration('hlsLens');
    const skip = config.get<string[]>('diagnostics.skip', []);
    const findings = graded(analyzeMpd(mpd.getText()).filter((f) => !skip.includes(f.rule) && !skip.includes(f.rule.split('/')[0])));
    sources.push({ label: 'This manifest', description: nameOf(locationOf(mpd)), entries: [{ path: locationOf(mpd), findings }] });
  }
  if (lastScan) {
    sources.push({ label: 'The last workspace scan', description: `${lastScan.length} manifests`, entries: lastScan });
  }
  if (sources.length === 0) {
    void vscode.window.showWarningMessage('HLS Lens: open a manifest, or run the workspace scan first.');
    return;
  }

  const source = sources.length === 1 ? sources[0] : await vscode.window.showQuickPick(sources, { title: 'HLS Lens: what to report on' });
  if (!source) return;
  const format = await vscode.window.showQuickPick(
    [
      { label: 'Markdown', description: 'for a ticket or a pull request', value: 'md' as const },
      { label: 'JSON', description: 'for whatever reads it next', value: 'json' as const },
    ],
    { title: 'HLS Lens: report format' },
  );
  if (!format) return;

  // The timestamp is passed in rather than taken in the core, which has to stay
  // deterministic to be testable.
  const options = { title: 'HLS Lens report', subtitle: `${source.label} · ${new Date().toISOString()}` };
  const content = format.value === 'md' ? renderFindingsMarkdown(source.entries, options) : renderFindingsJson(source.entries, options);
  const doc = await vscode.workspace.openTextDocument({ content, language: format.value === 'md' ? 'markdown' : 'json' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Manifests one scan will read before it stops and says so. */
const MAX_MANIFESTS = 2000;

/**
 * HL-31: every manifest in the workspace, not just the open one.
 *
 * The extension activates on the workspaceContains glob for m3u8 files and then waits for someone
 * to click a file — but the manifest with the defect is usually the one nobody
 * thought to open. This reads them all into their own diagnostic collection, so the
 * Problems panel lists files that were never loaded.
 */
async function checkWorkspace(): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showWarningMessage('HLS Lens: open a folder first — there is no workspace to scan.');
    return;
  }

  const config = vscode.workspace.getConfiguration('hlsLens');
  const exclude = config.get<string>('workspace.exclude', '**/node_modules/**');
  const uris = await vscode.workspace.findFiles('**/*.{m3u8,m3u,mpd}', exclude || null, MAX_MANIFESTS);
  if (uris.length === 0) {
    void vscode.window.showInformationMessage('HLS Lens: no manifests found in this workspace.');
    return;
  }

  const skip = config.get<string[]>('diagnostics.skip', []);
  const floor = config.get<Severity>('diagnostics.minSeverity', 'hint');
  const rank: Record<Severity, number> = { error: 0, warning: 1, hint: 2 };
  const entries: WorkspaceEntry[] = [];
  workspaceDiagnostics.clear();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'HLS Lens: reading the manifests', cancellable: true },
    async (progress, token) => {
      for (const [index, uri] of uris.entries()) {
        if (token.isCancellationRequested) return;
        const path = vscode.workspace.asRelativePath(uri);
        progress.report({ message: `${index + 1}/${uris.length} ${path}`, increment: 100 / uris.length });
        if (!isManifestPath(uri.path)) continue;
        let text: string;
        try {
          text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch (err) {
          output.appendLine(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        const findings = graded(
          uri.path.toLowerCase().endsWith('.mpd')
            ? analyzeMpd(text).filter((f) => !skip.includes(f.rule) && !skip.includes(f.rule.split('/')[0]))
            : analyze(parsePlaylist(text), {
                pdtDriftToleranceMs: config.get<number>('pdtDriftToleranceMs', 500),
                targetDurationSlack: config.get<number>('targetDurationSlack', 1.5),
                skip,
              })
        ).filter((f) => rank[f.severity] <= rank[floor]);

        entries.push({ path, findings });
        // The document is not open, so the ranges come from the text that was read.
        const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
        if (findings.length > 0) workspaceDiagnostics.set(uri, findings.map((f) => toDiagnosticAt(lines, f)));
      }
    },
  );

  lastScan = entries;
  const summary = summariseWorkspace(entries);
  output.appendLine('');
  for (const line of renderWorkspaceReport(summary)) output.appendLine(line);
  if (uris.length === MAX_MANIFESTS) {
    output.appendLine(`  (stopped at ${MAX_MANIFESTS} manifests: narrow the workspace, or set hlsLens.workspace.exclude)`);
  }
  output.show(true);

  const headline = renderWorkspaceReport(summary)[0];
  void vscode.window.showInformationMessage(`HLS Lens: ${headline}`);
}

/** A diagnostic for a file that is not open, so there is no TextDocument to measure. */
function toDiagnosticAt(lines: string[], finding: Finding): vscode.Diagnostic {
  const index = Math.min(finding.line, Math.max(lines.length - 1, 0));
  const text = lines[index] ?? '';
  const range = text.trim().length > 0 ? new vscode.Range(index, 0, index, text.length) : new vscode.Range(index, 0, index, 1);
  const message = finding.hint ? `${finding.message}\n\u2192 ${finding.hint}` : finding.message;
  const diagnostic = new vscode.Diagnostic(range, message, severityToVsCode(finding.severity));
  diagnostic.source = 'hls-lens';
  diagnostic.code = finding.rule;
  return diagnostic;
}

/** HL-12: the segments as a strip, and the renditions stacked on one axis. */
let timelinePanel: vscode.WebviewPanel | undefined;

async function showTimeline(): Promise<void> {
  const active = activeManifest();
  if (!active) {
    void vscode.window.showWarningMessage('HLS Lens: open a playlist first.');
    return;
  }

  const tracks: TimelineTrack[] = [];
  const variants = active.playlist.variants.filter((v) => !v.iframeOnly && v.uri);
  if (active.playlist.segments.length > 0) {
    tracks.push({ label: nameOf(active.location), playlist: active.playlist });
  } else if (variants.length > 0) {
    const config = vscode.workspace.getConfiguration('hlsLens');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'HLS Lens: reading the renditions', cancellable: true },
      async (progress, token) => {
        for (const [index, variant] of variants.entries()) {
          if (token.isCancellationRequested) return;
          progress.report({ message: `${index + 1}/${variants.length} ${variant.uri}`, increment: 100 / variants.length });
          const resolved = resolveUri(active.location, variant.uri);
          try {
            const text = isRemote(resolved)
              ? (
                  await fetchText(resolved, {
                    headers: config.get<Record<string, string>>('request.headers', {}),
                    timeoutMs: config.get<number>('request.timeoutMs', 15000),
                  })
                ).text
              : Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(resolved))).toString('utf8');
            // The label is the rung, which is what an operator recognises the row by.
            const label = variant.resolution
              ? `${variant.resolution.height}p`
              : variant.bandwidth !== null
                ? `${Math.round(variant.bandwidth / 1000)} kbps`
                : nameOf(variant.uri);
            tracks.push({ label, playlist: parsePlaylist(text) });
          } catch (err) {
            output.appendLine(`could not read ${variant.uri}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
    );
  }

  if (tracks.length === 0) {
    void vscode.window.showWarningMessage('HLS Lens: nothing to draw — no segments here, and no rendition could be read.');
    return;
  }

  const model = buildTimeline(tracks);
  const html = renderTimelineHtml(model, { title: nameOf(active.location), nonce: randomBytes(16).toString('hex') });

  if (!timelinePanel) {
    timelinePanel = vscode.window.createWebviewPanel('hlsLens.timeline', 'HLS Timeline', vscode.ViewColumn.Beside, {
      enableScripts: true,
      // Nothing is loaded from disk: the page is one string, built in the core.
      localResourceRoots: [],
    });
    timelinePanel.onDidDispose(() => {
      timelinePanel = undefined;
    });
    timelinePanel.webview.onDidReceiveMessage((message: { type?: string; line?: number }) => {
      if (message?.type === 'reveal' && typeof message.line === 'number') void revealLine(message.line);
    });
  }
  timelinePanel.title = `HLS Timeline — ${nameOf(active.location)}`;
  timelinePanel.webview.html = html;
  timelinePanel.reveal(vscode.ViewColumn.Beside, true);
}

/** nameOf is the last path segment of a path or URL, for a label. */
function nameOf(location: string): string {
  const withoutQuery = location.split('?')[0];
  return withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1) || withoutQuery;
}

/** HL-14: the deep check pointed at one rendition picked in the tree. */
async function deepCheckVariant(node?: TreeNode): Promise<void> {
  const active = activeManifest();
  if (!node?.uri || !active) {
    void vscode.window.showWarningMessage('HLS Lens: pick a rendition in the HLS view first.');
    return;
  }
  const resolved = resolveUri(active.location, node.uri);
  if (!isRemote(resolved)) {
    void vscode.window.showWarningMessage(`HLS Lens: segcheck needs an http(s) URL; "${resolved}" is a local path.`);
    return;
  }
  await deepCheck(resolved);
}

/** The live watch: one poller at a time, on one playlist. */
interface Watch {
  timer: NodeJS.Timeout;
  url: string;
  doc: vscode.Uri;
  previous: Playlist;
  stalls: number;
}
let watching: Watch | undefined;

/** Consecutive stalled reloads before saying so: one is a slow packager, two is a problem. */
const STALLS_BEFORE_WARNING = 2;

function toggleWatch(): void {
  if (watching) {
    stopWatch('stopped');
    return;
  }
  const active = activeManifest();
  if (!active) {
    void vscode.window.showWarningMessage('HLS Lens: open a manifest first.');
    return;
  }
  if (!isRemote(active.location)) {
    void vscode.window.showWarningMessage('HLS Lens: the watch reloads the playlist over HTTP, so it needs a manifest opened from a URL.');
    return;
  }
  if (active.playlist.hasEndList) {
    void vscode.window.showWarningMessage('HLS Lens: this playlist has EXT-X-ENDLIST — there is nothing left to watch.');
    return;
  }

  const interval = watchIntervalMs(active.playlist, vscode.workspace.getConfiguration('hlsLens').get<number>('watch.intervalSeconds', 0));
  output.appendLine(`watch: ${active.location} every ${interval / 1000}s`);
  output.show(true);
  watching = {
    timer: setInterval(() => void pollWatch(), interval),
    url: active.location,
    doc: active.doc.uri,
    previous: active.playlist,
    stalls: 0,
  };
  updateStatusBar();
  void vscode.window.showInformationMessage(`HLS Lens: watching the playlist every ${interval / 1000}s.`);
}

function stopWatch(reason: string): void {
  if (!watching) return;
  clearInterval(watching.timer);
  output.appendLine(`watch: ${reason}`);
  watching = undefined;
  updateStatusBar();
}

async function pollWatch(): Promise<void> {
  const current = watching;
  if (!current) return;
  const config = vscode.workspace.getConfiguration('hlsLens');
  let text: string;
  try {
    text = (
      await fetchText(current.url, {
        headers: config.get<Record<string, string>>('request.headers', {}),
        timeoutMs: config.get<number>('request.timeoutMs', 15000),
      })
    ).text;
  } catch (err) {
    // A failed reload is worth saying once, but it does not stop the watch: a live
    // edge that 404s for one poll is a normal thing on a CDN.
    output.appendLine(`watch: reload failed — ${(err as Error).message}`);
    return;
  }

  const next = parsePlaylist(text);
  const change = diffPlaylists(current.previous, next);
  current.previous = next;
  output.appendLine(`watch: ${describeChange(change)}`);

  if (change.endedNow) {
    void vscode.window.showInformationMessage('HLS Lens: the playlist gained EXT-X-ENDLIST — the stream ended.');
    stopWatch('the stream ended');
    return;
  }
  if (change.discontinuities.length > 0) {
    void vscode.window.showWarningMessage(`HLS Lens: a discontinuity appeared at ${change.discontinuities.join(', ')}.`);
  }
  if (change.stalled) {
    current.stalls++;
    if (current.stalls === STALLS_BEFORE_WARNING) {
      void vscode.window.showWarningMessage(
        `HLS Lens: the live window has not moved for ${STALLS_BEFORE_WARNING} reloads — the packager may have stopped.`,
      );
    }
  } else {
    current.stalls = 0;
  }
  updateStatusBar();
}
