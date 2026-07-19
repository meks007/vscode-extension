# PHP in XML Code CDATA

Adds PHP syntax highlighting to untagged PHP held in XML `code` elements.

```xml
<code><![CDATA[
$organisationId = 'org_id';

if ($organisationId === 'org_id') {
    echo 'Delete';
}
]]></code>
```

## Features

- XML outside `code` elements remains XML.
- Every `CDATA` section within a `code` element is tokenized as PHP.
- No `<?php` or `?>` tag is required or inserted.
- The Explorer has a Smart Outline view.
- Smart Outline is visible only when the active document provides symbols.
- Selecting a Smart Outline item opens its source location.

## Requirements

Keep VS Code's built-in PHP Language Basics extension enabled. It supplies the PHP TextMate grammar used by this extension.

## Limitation

This extension adds syntax highlighting only. PHP language-server functions such as diagnostics and autocomplete are not embedded into the XML document.
