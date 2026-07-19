const vscode = require('vscode');

function activate(context) {
  let requestId = 0;
  let refreshTimer;
  let lastDocumentUri;
  let lastHasSymbols;

  async function updateOutline() {
    const request = ++requestId;
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;

    if (!document || document.languageId !== 'php') {
      if (request !== requestId) return;
      lastDocumentUri = undefined;
      lastHasSymbols = undefined;
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      return;
    }

    try {
      const result = await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );

      if (
        request !== requestId ||
        document !== vscode.window.activeTextEditor?.document
      ) {
        return;
      }

      const hasSymbols = Array.isArray(result) && result.length > 0;
      const documentChanged = lastDocumentUri !== document.uri.toString();
      const stateChanged = lastHasSymbols !== hasSymbols;

      lastDocumentUri = document.uri.toString();
      lastHasSymbols = hasSymbols;

      if (hasSymbols && (documentChanged || stateChanged)) {
        await vscode.commands.executeCommand('outline.focus');
      } else if (!hasSymbols && (documentChanged || stateChanged)) {
        await vscode.commands.executeCommand(
          'workbench.action.closeAuxiliaryBar'
        );
      }
    } catch {
      if (request !== requestId) return;
      lastDocumentUri = document.uri.toString();
      lastHasSymbols = false;
      await vscode.commands.executeCommand(
        'workbench.action.closeAuxiliaryBar'
      );
    }
  }

  function scheduleUpdate() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void updateOutline();
    }, 150);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      lastDocumentUri = undefined;
      lastHasSymbols = undefined;
      scheduleUpdate();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        scheduleUpdate();
      }
    }),
    {
      dispose() {
        clearTimeout(refreshTimer);
        requestId++;
      }
    }
  );

  scheduleUpdate();
}

function deactivate() {}

module.exports = { activate, deactivate };
