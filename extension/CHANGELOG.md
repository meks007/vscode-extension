# Changelog

## 0.2.1

- Fix: Smart Outline sidebar no longer hides when switching to a document
  that has symbols. The bar is now closed only after all retries are
  exhausted and no symbols were found, preventing premature close while
  the language server is still loading. The open/focus command is also
  skipped when the sidebar is already visible, avoiding focus-steal flicker.

## 0.2.0

- Add Smart Outline view that is visible only when the active document has symbols.

## 0.1.0

- Add PHP syntax highlighting for untagged code in XML `<code><![CDATA[ ... ]]></code>` blocks.
