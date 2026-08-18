// A fake `vscode`, so the extension host glue can be tested without an extension host.
//
// src/extension.ts was exempt from the tests by convention — "it is only glue" — and
// that exemption has already cost this project a bug: the code action provider
// filtered diagnostics on `source === 'HLS Lens'` while the diagnostics carried
// 'hls-lens', so no quick fix would ever have appeared, and nothing failed.
//
// The alternative to this file is @vscode/test-electron, which downloads a copy of VS
// Code to run the tests in. That is the standard approach and it is the wrong one
// here: the suite is offline by rule, runs in a second, and needs no dependency it
// does not already have. Aliasing the module (see esbuild.mjs) buys the same coverage
// of *our* code — what it cannot check is that the real API behaves as modelled here,
// which is the price, and it is written down rather than hidden.
//
// Everything records what it was asked to do, so a test can assert on it.

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startLine: number | Position, startCharacter: number | Position, endLine?: number, endCharacter?: number) {
    if (startLine instanceof Position && startCharacter instanceof Position) {
      this.start = startLine;
      this.end = startCharacter;
    } else {
      this.start = new Position(startLine as number, startCharacter as number);
      this.end = new Position(endLine ?? 0, endCharacter ?? 0);
    }
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string = '',
  ) {}
  static file(path: string): Uri {
    return new Uri('file', '', path);
  }
  static parse(value: string): Uri {
    const match = /^([a-z-]+):(\/\/)?([^/?]*)([^?]*)(?:\?(.*))?$/i.exec(value);
    if (!match) return new Uri('file', '', value);
    return new Uri(match[1], match[3] ?? '', match[4] ?? '', match[5] ?? '');
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: { query?: string }): Uri {
    return new Uri(this.scheme, this.authority, this.path, change.query ?? this.query);
  }
  toString(): string {
    return `${this.scheme}:${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;
  code?: string;
  constructor(
    readonly range: Range,
    readonly message: string,
    readonly severity: DiagnosticSeverity,
  ) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState,
  ) {}
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(readonly value: string = '') {}
}

export class DocumentLink {
  constructor(
    readonly range: Range,
    readonly target?: Uri,
  ) {}
}

export class Hover {
  constructor(readonly contents: unknown) {}
}

export enum CompletionItemKind {
  Text = 0,
  Property = 9,
  Keyword = 13,
  Value = 11,
  Constant = 20,
}

export class CompletionItem {
  detail?: string;
  documentation?: unknown;
  insertText?: string;
  sortText?: string;
  constructor(
    readonly label: string,
    readonly kind?: CompletionItemKind,
  ) {}
}

export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  constructor(readonly value: string) {}
}

export class CodeAction {
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  constructor(
    readonly title: string,
    readonly kind?: CodeActionKind,
  ) {}
}

export class WorkspaceEdit {
  readonly edits: Array<{ uri: Uri; range?: Range; text: string; kind: 'replace' | 'insert' }> = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.edits.push({ uri, range, text, kind: 'replace' });
  }
  insert(uri: Uri, position: Position, text: string): void {
    this.edits.push({ uri, range: new Range(position, position), text, kind: 'insert' });
  }
}

export class EventEmitter<T> {
  private readonly listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => undefined);
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {}
}

export class Disposable {
  constructor(private readonly onDispose: () => void) {}
  dispose(): void {
    this.onDispose();
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
}

export enum ViewColumn {
  Beside = -2,
}

/** One diagnostic collection, keeping what was set so a test can read it back. */
export class FakeDiagnosticCollection {
  readonly entries = new Map<string, Diagnostic[]>();
  constructor(readonly name: string) {}
  set(uri: Uri, diagnostics: Diagnostic[]): void {
    this.entries.set(uri.toString(), diagnostics);
  }
  delete(uri: Uri): void {
    this.entries.delete(uri.toString());
  }
  clear(): void {
    this.entries.clear();
  }
  dispose(): void {}
}

/** A text document, built from a string. */
export function fakeDocument(text: string, path = '/w/live.m3u8', languageId = 'm3u8'): Record<string, unknown> {
  const lines = text.split('\n');
  return {
    uri: Uri.file(path),
    fileName: path,
    languageId,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (line: number) => ({
      text: lines[line] ?? '',
      range: new Range(line, 0, line, (lines[line] ?? '').length),
    }),
    positionAt: (offset: number) => new Position(0, offset),
  };
}

/** Everything the fake namespaces recorded, reset between tests. */
export const recorded = {
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  collections: new Map<string, FakeDiagnosticCollection>(),
  treeProviders: new Map<string, unknown>(),
  revealed: [] as unknown[],
  selectionListeners: [] as Array<(event: unknown) => void>,
  linkProviders: [] as Array<{ language: string; provider: unknown }>,
  hoverProviders: [] as Array<{ language: string; provider: unknown }>,
  completionProviders: [] as Array<{ language: string; provider: unknown }>,
  codeActionProviders: [] as Array<{ language: string; provider: unknown }>,
  messages: [] as string[],
  output: [] as string[],
  statusBar: { text: '', tooltip: '', command: '', visible: false },
  configuration: {} as Record<string, unknown>,
  activeDocument: undefined as Record<string, unknown> | undefined,
  openDocuments: [] as Array<Record<string, unknown>>,
  /** What the next showInputBox / showQuickPick should answer, so a command can be driven. */
  nextInput: undefined as string | undefined,
  nextPick: undefined as unknown,
  contexts: new Map<string, unknown>(),
};

export function resetRecorded(): void {
  recorded.commands.clear();
  recorded.collections.clear();
  recorded.treeProviders.clear();
  recorded.revealed.length = 0;
  recorded.selectionListeners.length = 0;
  recorded.linkProviders.length = 0;
  recorded.hoverProviders.length = 0;
  recorded.completionProviders.length = 0;
  recorded.codeActionProviders.length = 0;
  recorded.messages.length = 0;
  recorded.output.length = 0;
  recorded.statusBar = { text: '', tooltip: '', command: '', visible: false };
  recorded.configuration = {};
  recorded.activeDocument = undefined;
  recorded.openDocuments.length = 0;
  recorded.nextInput = undefined;
  recorded.nextPick = undefined;
  recorded.contexts.clear();
}

const noopDisposable = new Disposable(() => undefined);

export const languages = {
  createDiagnosticCollection(name: string): FakeDiagnosticCollection {
    const collection = new FakeDiagnosticCollection(name);
    recorded.collections.set(name, collection);
    return collection;
  },
  registerDocumentLinkProvider(selector: { language: string }, provider: unknown): Disposable {
    recorded.linkProviders.push({ language: selector.language, provider });
    return noopDisposable;
  },
  registerHoverProvider(selector: { language: string }, provider: unknown): Disposable {
    recorded.hoverProviders.push({ language: selector.language, provider });
    return noopDisposable;
  },
  registerCompletionItemProvider(selector: { language: string }, provider: unknown, ..._triggers: string[]): Disposable {
    recorded.completionProviders.push({ language: selector.language, provider });
    return noopDisposable;
  },
  registerCodeActionsProvider(selector: { language: string }, provider: unknown, _meta?: unknown): Disposable {
    recorded.codeActionProviders.push({ language: selector.language, provider });
    return noopDisposable;
  },
  setTextDocumentLanguage(document: unknown, _language: string): Promise<unknown> {
    return Promise.resolve(document);
  },
};

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable {
    recorded.commands.set(id, handler);
    return noopDisposable;
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    // setContext is what a `when` clause in package.json reads, so a test can check
    // that a toolbar button appears exactly when it should.
    if (id === 'setContext' && typeof args[0] === 'string') recorded.contexts.set(args[0], args[1]);
    return Promise.resolve(undefined);
  },
};

export const window = {
  get activeTextEditor(): unknown {
    return recorded.activeDocument ? { document: recorded.activeDocument, revealRange: () => undefined, selection: undefined } : undefined;
  },
  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => recorded.output.push(line),
      show: () => undefined,
      dispose: () => undefined,
    };
  },
  createStatusBarItem(_alignment: StatusBarAlignment, _priority: number) {
    return {
      set text(value: string) {
        recorded.statusBar.text = value;
      },
      get text() {
        return recorded.statusBar.text;
      },
      set tooltip(value: string) {
        recorded.statusBar.tooltip = value;
      },
      set command(value: string) {
        recorded.statusBar.command = value;
      },
      show: () => {
        recorded.statusBar.visible = true;
      },
      hide: () => {
        recorded.statusBar.visible = false;
      },
      dispose: () => undefined,
    };
  },
  registerTreeDataProvider(id: string, provider: unknown): Disposable {
    recorded.treeProviders.set(id, provider);
    return noopDisposable;
  },
  createTreeView(id: string, options: { treeDataProvider: unknown }) {
    recorded.treeProviders.set(id, options.treeDataProvider);
    return {
      visible: true,
      reveal(node: unknown): Promise<void> {
        recorded.revealed.push(node);
        return Promise.resolve();
      },
      dispose: () => undefined,
    };
  },
  onDidChangeTextEditorSelection(listener: (event: unknown) => void): Disposable {
    recorded.selectionListeners.push(listener);
    return noopDisposable;
  },
  showWarningMessage(message: string): Promise<undefined> {
    recorded.messages.push(`warning: ${message}`);
    return Promise.resolve(undefined);
  },
  showInformationMessage(message: string): Promise<undefined> {
    recorded.messages.push(`info: ${message}`);
    return Promise.resolve(undefined);
  },
  showErrorMessage(message: string): Promise<undefined> {
    recorded.messages.push(`error: ${message}`);
    return Promise.resolve(undefined);
  },
  showInputBox(_options?: unknown): Promise<string | undefined> {
    const answer = recorded.nextInput;
    recorded.nextInput = undefined;
    return Promise.resolve(answer);
  },
  showQuickPick(_items: unknown, _options?: unknown): Promise<unknown> {
    const answer = recorded.nextPick;
    recorded.nextPick = undefined;
    return Promise.resolve(answer);
  },
  showTextDocument(document: unknown, _options?: unknown): Promise<unknown> {
    return Promise.resolve({ document });
  },
  withProgress<T>(_options: unknown, task: (progress: unknown, token: unknown) => Promise<T>): Promise<T> {
    return task({ report: () => undefined }, { isCancellationRequested: false });
  },
  createWebviewPanel(_type: string, title: string, _column: ViewColumn, _options?: unknown) {
    return {
      title,
      webview: { html: '', onDidReceiveMessage: () => noopDisposable },
      onDidDispose: () => noopDisposable,
      reveal: () => undefined,
      dispose: () => undefined,
    };
  },
  onDidChangeActiveTextEditor(_listener: unknown): Disposable {
    return noopDisposable;
  },
};

export const workspace = {
  get textDocuments(): Array<Record<string, unknown>> {
    return recorded.openDocuments;
  },
  get workspaceFolders(): unknown[] | undefined {
    return [{ uri: Uri.file('/w'), name: 'w', index: 0 }];
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = recorded.configuration[`${section}.${key}`];
        return value === undefined ? fallback : (value as T);
      },
    };
  },
  asRelativePath(uri: Uri | string): string {
    const path = typeof uri === 'string' ? uri : uri.path;
    return path.replace(/^\/w\//, '');
  },
  openTextDocument(options: { content: string; language?: string }): Promise<unknown> {
    return Promise.resolve(fakeDocument(options.content, '/w/untitled', options.language ?? 'plaintext'));
  },
  registerTextDocumentContentProvider(_scheme: string, _provider: unknown): Disposable {
    return noopDisposable;
  },
  onDidOpenTextDocument(_listener: unknown): Disposable {
    return noopDisposable;
  },
  onDidSaveTextDocument(_listener: unknown): Disposable {
    return noopDisposable;
  },
  onDidCloseTextDocument(_listener: unknown): Disposable {
    return noopDisposable;
  },
  onDidChangeTextDocument(_listener: unknown): Disposable {
    return noopDisposable;
  },
  onDidChangeConfiguration(_listener: unknown): Disposable {
    return noopDisposable;
  },
  findFiles(_include: string, _exclude?: string | null, _max?: number): Promise<Uri[]> {
    return Promise.resolve([]);
  },
  fs: {
    readFile(_uri: Uri): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array());
    },
  },
};

/** The context activate() is handed. */
export function fakeContext(): { subscriptions: Array<{ dispose(): void }> } {
  return { subscriptions: [] };
}
