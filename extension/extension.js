const vscode = require('vscode');

class SmartOutlineProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.symbols = [];
  }

  setSymbols(symbols) {
    this.symbols = Array.isArray(symbols) ? symbols : [];
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(symbol) {
    const item = new vscode.TreeItem(
      symbol.name || '(unnamed symbol)',
      Array.isArray(symbol.children) && symbol.children.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    item.description = symbol.detail || undefined;
    item.command = {
      command: 'vscode.open',
      title: 'Open symbol',
      arguments: [symbol.uri, { selection: symbol.selectionRange || symbol.range }]
    };
    item.tooltip = symbol.detail || symbol.name;
    item.contextValue = 'phpCdataSmartOutline.symbol';
    return item;
  }

  getChildren(symbol) {
    return symbol ? (symbol.children || []) : this.symbols;
  }
}

function normalizeDocumentSymbol(symbol, uri) {
  return {
    ...symbol,
    uri,
    children: (symbol.children || []).map((child) => normalizeDocumentSymbol(child, uri))
  };
}

function normalizeSymbol(symbol, uri) {
  if (!symbol) return null;

  if (symbol.location) {
    return {
      ...symbol,
      uri: symbol.location.uri,
      range: symbol.location.range,
      selectionRange: symbol.location.range,
      children: []
    };
  }

  return normalizeDocumentSymbol(symbol, uri);
}

function activate(context) {
  const provider = new SmartOutlineProvider();
  const tree = vscode.window.createTreeView('phpCdataSmartOutline', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  let generation = 0;
  let retryTimers = [];

  async function setVisible(visible) {
    await vscode.commands.executeCommand(
      'setContext',
      'phpCdataSmartOutline.hasSymbols',
      visible
    );
  }

  function clearRetries() {
    for (const timer of retryTimers) {
      clearTimeout(timer);
    }
    retryTimers = [];
  }

  async function querySymbols(request) {
    const document = vscode.window.activeTextEditor?.document;

    if (!document || (document.isUntitled && document.getText().length === 0)) {
      if (request === generation) {
        provider.setSymbols([]);
        await setVisible(false);
      }
      return false;
    }

    try {
      const result = await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );

      if (request !== generation || document !== vscode.window.activeTextEditor?.document) {
        return false;
      }

      const symbols = (result || [])
        .map((symbol) => normalizeSymbol(symbol, document.uri))
        .filter(Boolean);

      provider.setSymbols(symbols);
      await setVisible(symbols.length > 0);
      return symbols.length > 0;
    } catch {
      if (request === generation) {
        provider.setSymbols([]);
        await setVisible(false);
      }
      return false;
    }
  }

  function scheduleRefresh() {
    clearRetries();
    const request = ++generation;

    void querySymbols(request);

    for (const delay of [150, 500, 1200, 2500]) {
      const timer = setTimeout(() => {
        void querySymbols(request);
      }, delay);
      retryTimers.push(timer);
    }
  }

  async function refresh() {
    scheduleRefresh();
  }

  context.subscriptions.push(
    tree,
    provider._onDidChangeTreeData,
    vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
    vscode.window.onDidChangeVisibleTextEditors(scheduleRefresh),
    vscode.workspace.onDidOpenTextDocument(scheduleRefresh),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        scheduleRefresh();
      }
    }),
    vscode.commands.registerCommand('phpCdataSmartOutline.refresh', refresh),
    { dispose: clearRetries }
  );

  void setVisible(false).then(scheduleRefresh);
}

function deactivate() {}

module.exports = { activate, deactivate };
