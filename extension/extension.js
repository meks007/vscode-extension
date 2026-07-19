const vscode = require('vscode');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTree(symbols, uri, parent) {
  parent = parent || null;
  return symbols.map(function (sym) {
    var node = { symbol: sym, uri: uri, parent: parent, children: [] };
    if (Array.isArray(sym.children) && sym.children.length) {
      node.children = buildTree(sym.children, uri, node);
    }
    return node;
  });
}

function flattenTree(roots, result) {
  result = result || [];
  for (var i = 0; i < roots.length; i++) {
    result.push(roots[i]);
    if (roots[i].children.length) {
      flattenTree(roots[i].children, result);
    }
  }
  return result;
}

function rangeContains(range, position) {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }
  if (
    position.line === range.start.line &&
    position.character < range.start.character
  ) {
    return false;
  }
  if (
    position.line === range.end.line &&
    position.character > range.end.character
  ) {
    return false;
  }
  return true;
}

function rangeSize(range) {
  if (!range) return Infinity;
  return (
    (range.end.line - range.start.line) * 100000 +
    (range.end.character - range.start.character)
  );
}

function symbolAtPosition(flat, position) {
  var best = null;
  for (var i = 0; i < flat.length; i++) {
    var node = flat[i];
    var range = node.symbol.range || (node.symbol.location && node.symbol.location.range);
    if (range && rangeContains(range, position)) {
      if (!best) {
        best = node;
      } else {
        var bestRange = best.symbol.range || (best.symbol.location && best.symbol.location.range);
        if (rangeSize(range) < rangeSize(bestRange)) {
          best = node;
        }
      }
    }
  }
  return best;
}

function kindToIcon(kind) {
  var map = {
    0:  'symbol-file',
    1:  'symbol-module',
    2:  'symbol-namespace',
    3:  'symbol-package',
    4:  'symbol-class',
    5:  'symbol-method',
    6:  'symbol-property',
    7:  'symbol-field',
    8:  'symbol-constructor',
    9:  'symbol-enum',
    10: 'symbol-interface',
    11: 'symbol-function',
    12: 'symbol-variable',
    13: 'symbol-constant',
    14: 'symbol-string',
    15: 'symbol-number',
    16: 'symbol-boolean',
    17: 'symbol-array',
    18: 'symbol-object',
    19: 'symbol-key',
    20: 'symbol-null',
    21: 'symbol-enum-member',
    22: 'symbol-struct',
    23: 'symbol-event',
    24: 'symbol-operator',
    25: 'symbol-type-parameter'
  };
  return map[kind] || 'symbol-misc';
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

function SmartOutlineProvider() {
  this._onDidChangeTreeData = new vscode.EventEmitter();
  this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  this._roots = [];
  this._flat = [];
}

SmartOutlineProvider.prototype.setSymbols = function (roots, flat) {
  this._roots = roots;
  this._flat = flat;
  this._onDidChangeTreeData.fire(undefined);
};

SmartOutlineProvider.prototype.getFlat = function () {
  return this._flat;
};

SmartOutlineProvider.prototype.getTreeItem = function (node) {
  var sym = node.symbol;
  var hasChildren = node.children && node.children.length > 0;
  var state = hasChildren
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.None;

  var item = new vscode.TreeItem(sym.name || '(unnamed)', state);
  item.description = sym.detail || undefined;
  item.tooltip = sym.detail || sym.name;
  item.iconPath = new vscode.ThemeIcon(kindToIcon(sym.kind));

  var range = sym.selectionRange || sym.range || (sym.location && sym.location.range);
  if (range && node.uri) {
    item.command = {
      command: 'vscode.open',
      title: 'Go to symbol',
      arguments: [node.uri, { selection: range }]
    };
  }

  return item;
};

SmartOutlineProvider.prototype.getChildren = function (node) {
  if (!node) return this._roots;
  return node.children || [];
};

SmartOutlineProvider.prototype.getParent = function (node) {
  return node.parent || null;
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  var provider = new SmartOutlineProvider();

  var treeView = vscode.window.createTreeView('phpSmartOutline', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  var generation = 0;
  var retryTimers = [];
  var selectionTimer;

  function clearRetries() {
    for (var i = 0; i < retryTimers.length; i++) {
      clearTimeout(retryTimers[i]);
    }
    retryTimers = [];
  }

  function revealCurrent(editor) {
    if (!editor) return;
    var position = editor.selection.active;
    var flat = provider.getFlat();
    if (!flat.length) return;
    var node = symbolAtPosition(flat, position);
    if (node) {
      treeView.reveal(node, { select: true, focus: false, expand: true }).then(
        undefined,
        function () {}
      );
    }
  }

  function refreshSymbols(request) {
    var editor = vscode.window.activeTextEditor;
    var document = editor && editor.document;

    if (!document || document.languageId !== 'php') {
      if (request !== generation) return;
      provider.setSymbols([], []);
      vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      return;
    }

    vscode.commands
      .executeCommand('vscode.executeDocumentSymbolProvider', document.uri)
      .then(
        function (result) {
          if (
            request !== generation ||
            document !== vscode.window.activeTextEditor.document
          ) {
            return;
          }

          var symbols = Array.isArray(result) ? result : [];

          if (symbols.length === 0) {
            provider.setSymbols([], []);
            vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            return;
          }

          var roots = buildTree(symbols, document.uri, null);
          var flat = flattenTree(roots, []);
          provider.setSymbols(roots, flat);

          vscode.commands.executeCommand('phpSmartOutline.focus').then(
            function () { revealCurrent(vscode.window.activeTextEditor); },
            function () {}
          );
        },
        function () {
          if (request !== generation) return;
          provider.setSymbols([], []);
          vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        }
      );
  }

  function scheduleRefresh() {
    clearRetries();
    var request = ++generation;
    var delays = [0, 200, 600, 1400, 3000];
    for (var i = 0; i < delays.length; i++) {
      (function (d) {
        var t = setTimeout(function () { refreshSymbols(request); }, d);
        retryTimers.push(t);
      })(delays[i]);
    }
  }

  context.subscriptions.push(
    treeView,
    provider._onDidChangeTreeData,

    vscode.window.onDidChangeActiveTextEditor(function () {
      scheduleRefresh();
    }),

    vscode.workspace.onDidChangeTextDocument(function (event) {
      if (
        vscode.window.activeTextEditor &&
        event.document === vscode.window.activeTextEditor.document
      ) {
        scheduleRefresh();
      }
    }),

    vscode.window.onDidChangeTextEditorSelection(function (event) {
      if (event.textEditor !== vscode.window.activeTextEditor) return;
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(function () {
        revealCurrent(event.textEditor);
      }, 80);
    }),

    vscode.commands.registerCommand('phpSmartOutline.refresh', function () {
      scheduleRefresh();
    }),

    {
      dispose: function () {
        clearRetries();
        clearTimeout(selectionTimer);
        generation++;
      }
    }
  );

  scheduleRefresh();
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate };
