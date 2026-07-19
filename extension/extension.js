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

function normalizeSymbol(symbol, uri) {
  if (!symbol) return null;

  if (symbol.location) {
    return {
      ...symbol,
      uri: symbol.location.uri,
      range: symbol.location.range,
      selectionRange: symbol.location.range
    };
  }

  return { ...symbol, uri };
}

function activate(context) {
  const provider = new SmartOutlineProvider();
  const tree = vscode.window.createTreeView('phpCdataSmartOutline', {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  let sequence = 0;
  let timer;

  async function refresh() {
    const document = vscode.window.activeTextEditor?.document;
    const request = ++sequence;

    if (!document || (document.isUntitled && document.getText().length === 0)) {
      provider.setSymbols([]);
      await vscode.commands.executeCommand('setContext', 'phpCdataSmartOutline.hasSymbols', false);
      return;
    }

    try {
      const result = await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );

      if (request !== sequence) return;

      const symbols = (result || [])
        .map((symbol) => normalizeSymbol(symbol, document.uri))
        .filter(Boolean);

      provider.setSymbols(symbols);
      await vscode.commands.executeCommand(
        'setContext',
        'phpCdataSmartOutline.hasSymbols',
        symbols.length > 0
      );
    } catch {
      if (request !== sequence) return;
      provider.setSymbols([]);
      await vscode.commands.executeCommand('setContext', 'phpCdataSmartOutline.hasSymbols', false);
    }
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 160);
  }

  context.subscriptions.push(
    tree,
    provider._onDidChangeTreeData,
    vscode.window.onDidChangeActiveTextEditor(scheduleRefresh),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        scheduleRefresh();
      }
    }),
    vscode.commands.registerCommand('phpCdataSmartOutline.refresh', refresh)
  );

  scheduleRefresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
