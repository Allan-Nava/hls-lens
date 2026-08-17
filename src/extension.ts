// Extension host glue: diagnostics, the manifest tree, document links, the URL
// fetcher and the segcheck deep check.
//
// Everything that decides anything lives in src/core (pure, tested). This file
// translates between that model and the editor, and is deliberately thin.
import * as vscode from 'vscode';
import { spawn } from 'child_process';

import { analyze, Finding, RULES, Severity } from './core/analyze';
import { buildLadder, LadderRow, ladderSummary, renditionRows } from './core/ladder';
import { parsePlaylist, Playlist, looksLikePlaylist } from './core/playlist';
import { buildSegcheckArgs, parseSegcheckResult, segcheckSummary, segcheckToFindings } from './core/segcheck';
import { fetchText } from './core/fetch';
import { completeAt, renderTagHover, tagSpec } from './core/spec';
import { quickFixesFor } from './core/fixes';
import { isRemote, looksLikePlaylistUri, resolveUri } from './core/uri';

/** Scheme of the read-only documents holding manifests fetched from a URL. */
const SCHEME = 'hls-lens';

/** Contents of the fetched manifests, keyed by virtual document URI. */
const fetched = new Map<string, string>();

let diagnostics: vscode.DiagnosticCollection;
let deepDiagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let tree: ManifestTreeProvider;

export function activate(context: vscode.ExtensionContext): void {
  diagnostics = vscode.languages.createDiagnosticCollection('hls-lens');
  deepDiagnostics = vscode.languages.createDiagnosticCollection('hls-lens-segcheck');
  output = vscode.window.createOutputChannel('HLS Lens');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  tree = new ManifestTreeProvider();

  context.subscriptions.push(
    diagnostics,
    deepDiagnostics,
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
      fetched.delete(doc.uri.toString());
      refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isPlaylistDocument(event.document)) return;
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

function updateDiagnostics(doc: vscode.TextDocument): void {
  if (!isPlaylistDocument(doc)) return;
  const config = vscode.workspace.getConfiguration('hlsLens');
  if (!config.get<boolean>('diagnostics.enabled', true)) {
    diagnostics.delete(doc.uri);
    return;
  }
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
    findings.filter((f) => rank[f.severity] <= rank[floor]).map((f) => toDiagnostic(doc, f)),
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
    findings: analyze(playlist, {
      pdtDriftToleranceMs: config.get<number>('pdtDriftToleranceMs', 500),
      targetDurationSlack: config.get<number>('targetDurationSlack', 1.5),
      skip: config.get<string[]>('diagnostics.skip', []),
    }),
  };
}

function updateStatusBar(): void {
  const active = activeManifest();
  if (!active || active.playlist.kind === 'unknown') {
    statusBar.hide();
    return;
  }
  statusBar.text = `$(list-tree) ${ladderSummary(active.playlist)}`;
  statusBar.tooltip = 'HLS Lens — click to open the manifest tree';
  statusBar.command = 'hlsLens.refresh';
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
    if (!active) return [];
    return buildTree(active);
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

  if (findings.length > 0) {
    const children = findings.map((finding) => {
      const node = new TreeNode(finding.rule, 'finding', vscode.TreeItemCollapsibleState.None, [], '', finding.line);
      node.description = `line ${finding.line + 1} · ${finding.message}`;
      node.tooltip = new vscode.MarkdownString(`**${finding.rule}**\n\n${finding.message}${finding.hint ? `\n\n→ ${finding.hint}` : ''}`);
      node.iconPath = new vscode.ThemeIcon(
        finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warning' : 'info',
      );
      return node;
    });
    nodes.push(section(`Problems (${findings.length})`, 'warning', children, vscode.TreeItemCollapsibleState.Expanded));
  }

  return nodes;
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
async function deepCheck(): Promise<void> {
  const active = activeManifest();
  const suggested = active && isRemote(active.location) ? active.location : '';
  const url = await vscode.window.showInputBox({
    title: 'Deep check with segcheck',
    prompt: 'Manifest URL to download and inspect',
    value: suggested,
    placeHolder: 'https://cdn.example.com/hls/master.m3u8',
    validateInput: (value) => (isRemote(value.trim()) ? undefined : 'segcheck downloads segments, so it needs an http(s) URL'),
  });
  if (!url) return;

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
