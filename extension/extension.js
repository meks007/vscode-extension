const vscode = require('vscode');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var SYMBOL_KIND_FIELD = 7;

function buildLabel(sym) {
  var name = sym.name || '(unnamed)';

  // If the symbol has children that are all Field-kind (XML attributes),
  // fold them into the label and return null children so they are dropped.
  if (Array.isArray(sym.children) && sym.children.length) {
    var allFields = sym.children.every(function (c) {
      return c.kind === SYMBOL_KIND_FIELD;
    });
    if (allFields) {
      var attrs = sym.children.map(function (c) {
        // Strip leading "@" that XML providers often add to attribute names.
        var attrName = c.name.replace(/^@/, '');
        // detail holds the value when present.
        return c.detail ? attrName + '=' + c.detail : attrName;
      });
      return { label: name + ' [' + attrs.join(', ') + ']', dropChildren: true };
    }
  }

  return { label: name, dropChildren: false };
}

function buildTree(symbols, uri, parent, depth) {
  parent = parent || null;
  depth  = depth  || 0;
  return symbols.map(function (sym) {
    var built = buildLabel(sym);
    var node = {
      symbol:      sym,
      label:       built.label,
      uri:         uri,
      parent:      parent,
      children:    [],
      depth:       depth
    };

    if (!built.dropChildren && Array.isArray(sym.children) && sym.children.length) {
      // Filter out any remaining Field-kind children (stray attributes).
      var nonFields = sym.children.filter(function (c) {
        return c.kind !== SYMBOL_KIND_FIELD;
      });
      node.children = buildTree(nonFields, uri, node, depth + 1);
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
    var node  = flat[i];
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
  this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
  this._roots = [];
  this._flat  = [];
}

SmartOutlineProvider.prototype.setSymbols = function (roots, flat) {
  this._roots = roots;
  this._flat  = flat;
  this._onDidChangeTreeData.fire(undefined);
};

SmartOutlineProvider.prototype.getFlat = function () {
  return this._flat;
};

SmartOutlineProvider.prototype.getTreeItem = function (node) {
  var sym         = node.symbol;
  var hasChildren = node.children && node.children.length > 0;

  // Root nodes (depth 0) start collapsed so the user sees a clean list.
  // Deeper nodes start collapsed too; reveal() will expand them on demand.
  var state = hasChildren
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;

  var item       = new vscode.TreeItem(node.label, state);
  item.tooltip   = node.label;
  item.iconPath  = new vscode.ThemeIcon(kindToIcon(sym.kind));

  var range = sym.selectionRange || sym.range || (sym.location && sym.location.range);
  if (range && node.uri) {
    item.command = {
      command:   'vscode.open',
      title:     'Go to symbol',
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
    showCollapseAll:  true
  });

  var generation    = 0;
  var retryTimers   = [];
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
    var flat     = provider.getFlat();
    if (!flat.length) return;
    var node = symbolAtPosition(flat, position);
    if (node) {
      treeView.reveal(node, { select: true, focus: false, expand: 1 }).then(
        undefined,
        function () {}
      );
    }
  }

  function refreshSymbols(request) {
    var editor   = vscode.window.activeTextEditor;
    var document = editor && editor.document;

    if (!document) {
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
            !vscode.window.activeTextEditor ||
            document !== vscode.window.activeTextEditor.document
          ) {
            return;
          }

          var symbols = Array.isArray(result) ? result : [];

          if (symbols.length === 0) {
            if (request === generation) {
              provider.setSymbols([], []);
              vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            }
            return;
          }

          var roots = buildTree(symbols, document.uri, null, 0);
          var flat  = flattenTree(roots, []);
          provider.setSymbols(roots, flat);

          vscode.commands.executeCommand('workbench.action.openAuxiliaryBar').then(
            function () {
              vscode.commands.executeCommand('phpSmartOutline.focus').then(
                function () { revealCurrent(vscode.window.activeTextEditor); },
                function () {}
              );
            },
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
    // First attempt immediately, then retry to allow language servers to settle.
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

    // Fires when the user switches tabs.
    vscode.window.onDidChangeActiveTextEditor(function () {
      scheduleRefresh();
    }),

    // Fires when a file is opened in a new window (e.g. double-click in
    // Windows Explorer). At that point activeTextEditor may already be set
    // but onDidChangeActiveTextEditor has not fired yet.
    vscode.window.onDidChangeVisibleTextEditors(function () {
      scheduleRefresh();
    }),

    // Re-query when the document is edited so newly added symbols appear.
    vscode.workspace.onDidChangeTextDocument(function (event) {
      if (
        vscode.window.activeTextEditor &&
        event.document === vscode.window.activeTextEditor.document
      ) {
        scheduleRefresh();
      }
    }),

    // Follow cursor.
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

  // Run immediately on activation so opening a file via Windows Explorer
  // shows the outline without requiring a click first.
  scheduleRefresh();
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate };
