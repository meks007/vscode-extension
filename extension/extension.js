const vscode = require('vscode');

function activate(context) {
  let generation = 0;
  let retryTimers = [];
  let lastDocumentUri;
  let lastHasSymbols;

  function clearRetries() {
    for (const timer of retryTimers) {
      clearTimeout(timer);
    }
    retryTimers = [];
  }

  async function updateOutline(request) {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;

    if (!document || document.languageId !== 'php') {
      if (request !== generation) return;
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
        request !== generation ||
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
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      }
    } catch {
      if (request !== generation) return;
      lastDocumentUri = document.uri.toString();
      lastHasSymbols = false;
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    }
  }

  function scheduleUpdate() {
    clearRetries();
    const request = ++generation;
    const delays = [0, 150, 500, 1200, 2500];

    for (const delay of delays) {
      const timer = setTimeout(() => {
        void updateOutline(request);
      }, delay);
      retryTimers.push(timer);
    }
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
        clearRetries();
        generation++;
      }
    }
  );

  scheduleUpdate();
}

function deactivate() {}

module.exports = { activate, deactivate };
