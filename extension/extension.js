const vscode = require('vscode');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTree(symbols, uri, parent, depth) {
  parent = parent || null;
  depth  = depth  || 0;
  return symbols.map(function (sym) {
    var node = {
      symbol:   sym,
      uri:      uri,
      parent:   parent,
      children: [],
      depth:    depth
    };
    if (Array.isArray(sym.children) && sym.children.length) {
      node.children = buildTree(sym.children, uri, node, depth + 1);
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
  if (position.line < range.start.line || position.line > range.end.line) return false;
  if (position.line === range.start.line && position.character < range.start.character) return false;
  if (position.line === range.end.line   && position.character > range.end.character)   return false;
  return true;
}

function rangeSize(range) {
  if (!range) return Infinity;
  return (range.end.line - range.start.line) * 100000 + (range.end.character - range.start.character);
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
        if (rangeSize(range) < rangeSize(bestRange)) best = node;
      }
    }
  }
  return best;
}

function kindToIcon(kind) {
  var map = {
    0:'symbol-file', 1:'symbol-module', 2:'symbol-namespace', 3:'symbol-package',
    4:'symbol-class', 5:'symbol-method', 6:'symbol-property', 7:'symbol-field',
    8:'symbol-constructor', 9:'symbol-enum', 10:'symbol-interface', 11:'symbol-function',
    12:'symbol-variable', 13:'symbol-constant', 14:'symbol-string', 15:'symbol-number',
    16:'symbol-boolean', 17:'symbol-array', 18:'symbol-object', 19:'symbol-key',
    20:'symbol-null', 21:'symbol-enum-member', 22:'symbol-struct', 23:'symbol-event',
    24:'symbol-operator', 25:'symbol-type-parameter'
  };
  return map[kind] || 'symbol-misc';
}

// ---------------------------------------------------------------------------
// Debug helper: writes raw symbol tree to Output channel
// ---------------------------------------------------------------------------

function dumpSymbols(symbols, indent, lines) {
  indent = indent || '';
  lines  = lines  || [];
  for (var i = 0; i < symbols.length; i++) {
    var s = symbols[i];
    lines.push(
      indent +
      'name=' + s.name +
      ' kind=' + s.kind +
      ' detail=' + (s.detail || '') +
      ' children=' + (Array.isArray(s.children) ? s.children.length : 0)
    );
    if (Array.isArray(s.children) && s.children.length) {
      dumpSymbols(s.children, indent + '  ', lines);
    }
  }
  return lines;
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

SmartOutlineProvider.prototype.getFlat = function () { return this._flat; };

SmartOutlineProvider.prototype.getTreeItem = function (node) {
  var sym         = node.symbol;
  var hasChildren = node.children && node.children.length > 0;
  var state = hasChildren
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.None;

  var item      = new vscode.TreeItem(sym.name || '(unnamed)', state);
  item.tooltip  = sym.detail || sym.name;
  item.iconPath = new vscode.ThemeIcon(kindToIcon(sym.kind));

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
  var output   = vscode.window.createOutputChannel('Smart Outline Debug');

  var treeView = vscode.window.createTreeView('phpSmartOutline', {
    treeDataProvider: provider,
    showCollapseAll:  true
  });

  var generation   = 0;
  var retryTimers  = [];
  var revealTimer;
  var selectionTimer;

  function clearRetries() {
    for (var i = 0; i < retryTimers.length; i++) clearTimeout(retryTimers[i]);
    retryTimers = [];
  }

  // Reveal the symbol at the current cursor position.
  // IMPORTANT: treeView.reveal() always forces the sidebar open (VS Code
  // built-in behaviour, see github.com/microsoft/vscode/issues/96146).
  // We therefore only call it when we know the view is already visible so
  // we never accidentally reopen a sidebar the user has closed.
  // Also, reveal() must be called AFTER the tree has been re-rendered
  // following a setSymbols() call, so it is always invoked via a short
  // setTimeout rather than synchronously.
  function revealCurrent(editor) {
    if (!editor) return;
    if (!treeView.visible) return;
    var flat = provider.getFlat();
    if (!flat.length) return;
    var node = symbolAtPosition(flat, editor.selection.active);
    if (node) {
      treeView.reveal(node, { select: true, focus: false, expand: 2 })
        .then(undefined, function () {});
    }
  }

  // Open the bar and focus our view, then reveal the current symbol once
  // the tree has had time to render the new data.
  function openAndReveal(editor) {
    vscode.commands.executeCommand('workbench.action.openAuxiliaryBar').then(
      function () {
        vscode.commands.executeCommand('phpSmartOutline.focus').then(
          function () {
            // Delay the reveal so the tree has finished rendering the newly
            // set symbols. Calling reveal() immediately after fire() causes
            // "Data tree node not found" (github.com/microsoft/vscode/issues/96089).
            clearTimeout(revealTimer);
            revealTimer = setTimeout(function () {
              revealCurrent(editor || vscode.window.activeTextEditor);
            }, 150);
          },
          function () {}
        );
      },
      function () {}
    );
  }

  function refreshSymbols(request, attemptIndex) {
    attemptIndex = attemptIndex || 0;
    var delays = [0, 200, 600, 1400, 3000];
    var isLast = (attemptIndex === delays.length - 1);

    var editor   = vscode.window.activeTextEditor;
    var document = editor && editor.document;

    if (!document) {
      if (request !== generation) return;
      provider.setSymbols([], []);
      vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      return;
    }

    vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri).then(
      function (result) {
        if (request !== generation) return;
        if (!vscode.window.activeTextEditor) return;
        if (document !== vscode.window.activeTextEditor.document) return;

        var symbols = Array.isArray(result) ? result : [];

        if (symbols.length === 0) {
          // Do not close the bar on early retries: the language server may
          // still be loading symbols. Only act on the last attempt.
          if (isLast) {
            provider.setSymbols([], []);
            vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
          }
          return;
        }

        var roots = buildTree(symbols, document.uri, null, 0);
        var flat  = flattenTree(roots, []);
        provider.setSymbols(roots, flat);

        // If the sidebar is already showing our view, just reveal the
        // current symbol after giving the tree time to re-render.
        // If it is not visible, open it and then reveal.
        // We intentionally re-check treeView.visible here (after
        // setSymbols) rather than caching it before, because the
        // onDidChangeActiveTextEditor event fires before VS Code has
        // finished updating the panel state.
        if (treeView.visible) {
          clearTimeout(revealTimer);
          revealTimer = setTimeout(function () {
            revealCurrent(vscode.window.activeTextEditor);
          }, 150);
        } else {
          openAndReveal(vscode.window.activeTextEditor);
        }
      },
      function () {
        if (request !== generation) return;
        if (isLast) {
          provider.setSymbols([], []);
          vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        }
      }
    );
  }

  function scheduleRefresh() {
    clearRetries();
    var request = ++generation;
    var delays  = [0, 200, 600, 1400, 3000];
    for (var i = 0; i < delays.length; i++) {
      (function (d, idx) {
        var t = setTimeout(function () { refreshSymbols(request, idx); }, d);
        retryTimers.push(t);
      })(delays[i], i);
    }
  }

  context.subscriptions.push(
    treeView,
    output,
    provider._onDidChangeTreeData,

    vscode.window.onDidChangeActiveTextEditor(function () { scheduleRefresh(); }),
    vscode.window.onDidChangeVisibleTextEditors(function () { scheduleRefresh(); }),

    vscode.workspace.onDidChangeTextDocument(function (event) {
      if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
        scheduleRefresh();
      }
    }),

    vscode.window.onDidChangeTextEditorSelection(function (event) {
      if (event.textEditor !== vscode.window.activeTextEditor) return;
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(function () { revealCurrent(event.textEditor); }, 80);
    }),

    vscode.commands.registerCommand('phpSmartOutline.refresh', function () { scheduleRefresh(); }),

    vscode.commands.registerCommand('phpSmartOutline.dumpSymbols', function () {
      var editor   = vscode.window.activeTextEditor;
      var document = editor && editor.document;
      if (!document) {
        vscode.window.showInformationMessage('No active document.');
        return;
      }
      vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri).then(
        function (result) {
          var symbols = Array.isArray(result) ? result : [];
          output.clear();
          output.appendLine('--- Symbol dump: ' + document.uri.toString());
          output.appendLine('Root count: ' + symbols.length);
          var lines = dumpSymbols(symbols, '', []);
          for (var i = 0; i < lines.length; i++) output.appendLine(lines[i]);
          output.show(true);
        },
        function (err) {
          output.appendLine('Error: ' + String(err));
          output.show(true);
        }
      );
    }),

    {
      dispose: function () {
        clearRetries();
        clearTimeout(revealTimer);
        clearTimeout(selectionTimer);
        generation++;
      }
    }
  );

  scheduleRefresh();
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate };
